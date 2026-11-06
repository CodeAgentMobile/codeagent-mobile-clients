/**
 * Antigravity CLI (`agy`) — the four seams a new agent breaks at: ACP dispatch,
 * self-hosted credential delivery (both auth kinds), the headless one-shot
 * (Preview detection + AI summaries), and `codeam link` token validation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAcpAdapter,
  requiresAcp,
  resetAcpAdapterCacheForTests,
} from '../../src/agents/acp/adapters';
import { provisionAgentCredentials } from '../../src/commands/host/agent-provisioning';
import { AntigravityRuntimeStrategy } from '../../src/agents/antigravity/runtime';
import { validateLocalAntigravityToken } from '../../src/agents/antigravity/local-token';
import type { OsStrategy } from '../../src/os';

const OAUTH_BLOB = JSON.stringify({
  token: {
    access_token: 'ya29.test',
    token_type: 'Bearer',
    refresh_token: '1//refresh',
    expiry: '2026-11-06T13:00:00Z',
  },
  auth_method: 'consumer',
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-agy-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tokenFile = (): string =>
  path.join(tmp, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const settingsFile = (): string => path.join(tmp, '.gemini', 'antigravity-cli', 'settings.json');
const readSettings = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;

describe('antigravity ACP adapter', () => {
  beforeEach(() => resetAcpAdapterCacheForTests());

  it('runs over ACP via the native `agy acp` server', () => {
    expect(requiresAcp('antigravity')).toBe(true);
    const spec = getAcpAdapter('antigravity');
    expect(spec?.command).toBe('agy');
    expect(spec?.requiresAgentBinary).toBe('agy');
  });

  it('does NOT skip permissions — our runner answers session/request_permission', () => {
    expect(getAcpAdapter('antigravity')?.args).toEqual(['acp']);
  });
});

describe('antigravity self-hosted credential provisioning', () => {
  it('oauth_token: writes the blob verbatim to agy’s token file, 0600, no env', () => {
    const env = provisionAgentCredentials('antigravity', { kind: 'oauth_token', value: OAUTH_BLOB }, tmp);
    expect(env).toEqual({});
    expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(OAUTH_BLOB);
    if (process.platform !== 'win32') {
      expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    }
  });

  it('oauth_token: rejects a non-JSON or token-less blob instead of writing it', () => {
    expect(() =>
      provisionAgentCredentials('antigravity', { kind: 'oauth_token', value: 'ya29.bare' }, tmp),
    ).toThrow(/not valid JSON/);
    expect(() =>
      provisionAgentCredentials(
        'antigravity',
        { kind: 'oauth_token', value: JSON.stringify({ access_token: 'flat' }) },
        tmp,
      ),
    ).toThrow(/token\.access_token/);
    expect(fs.existsSync(tokenFile())).toBe(false);
  });

  it('api_key: exports GEMINI_API_KEY AND sets modelProvider=gemini (env alone does nothing)', () => {
    const env = provisionAgentCredentials('antigravity', { kind: 'api_key', value: 'AIzaTest' }, tmp);
    expect(env).toEqual({ GEMINI_API_KEY: 'AIzaTest' });
    expect(readSettings()).toEqual({ modelProvider: 'gemini' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
    }
  });

  it('api_key: merges into an existing settings.json and removes a shadowing OAuth login', () => {
    provisionAgentCredentials('antigravity', { kind: 'oauth_token', value: OAUTH_BLOB }, tmp);
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark' }));
    provisionAgentCredentials('antigravity', { kind: 'api_key', value: 'AIzaTest' }, tmp);
    expect(fs.existsSync(tokenFile())).toBe(false);
    expect(readSettings()).toEqual({ theme: 'dark', modelProvider: 'gemini' });
  });

  it('switching back to oauth_token drops modelProvider and keeps the other settings', () => {
    provisionAgentCredentials('antigravity', { kind: 'api_key', value: 'AIzaTest' }, tmp);
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark', modelProvider: 'gemini' }));
    provisionAgentCredentials('antigravity', { kind: 'oauth_token', value: OAUTH_BLOB }, tmp);
    expect(readSettings()).toEqual({ theme: 'dark' });
    expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(OAUTH_BLOB);
  });
});

describe.skipIf(process.platform === 'win32')('AntigravityRuntimeStrategy.generateOneShot', () => {
  /** A fake `agy` on disk: an executable shell script with the given body. */
  function fakeAgy(body: string): string {
    const bin = path.join(tmp, 'agy');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  }
  const osWith = (bin: string | null): OsStrategy =>
    ({
      id: 'linux',
      findInPath: () => bin,
      buildLaunch: (cmd: string, args: string[]) => ({ cmd, args }),
    }) as unknown as OsStrategy;

  it('runs `agy -p <prompt> --print-timeout <n>s` and returns its stdout', async () => {
    // Echo argv back, one arg per line, so the test sees exactly what agy got.
    const bin = fakeAgy('for a in "$@"; do echo "$a"; done');
    const out = await new AntigravityRuntimeStrategy(osWith(bin)).generateOneShot('detect it', {
      timeoutMs: 30_000,
    });
    expect(out?.split('\n')).toEqual(['-p', 'detect it', '--print-timeout', '30s']);
  });

  it('returns null when agy hangs (signed out, waiting for a pasted code)', async () => {
    const bin = fakeAgy('sleep 30');
    const out = await new AntigravityRuntimeStrategy(osWith(bin)).generateOneShot('x', {
      timeoutMs: 1,
    });
    expect(out).toBeNull();
  }, 15_000);

  it('returns null and surfaces stdout when agy exits non-zero', async () => {
    const bin = fakeAgy('echo "API_KEY_INVALID"; exit 1');
    let failed = '';
    const out = await new AntigravityRuntimeStrategy(osWith(bin)).generateOneShot('x', {
      onFailedOutput: (s) => {
        failed = s;
      },
    });
    expect(out).toBeNull();
    expect(failed).toBe('API_KEY_INVALID');
  });

  it('returns null when agy is not installed', async () => {
    expect(await new AntigravityRuntimeStrategy(osWith(null)).generateOneShot('x')).toBeNull();
  });
});

describe('validateLocalAntigravityToken (codeam link)', () => {
  it('a blob with a refresh token is valid even past its access-token expiry', () => {
    expect(validateLocalAntigravityToken({ method: 'oauth', credential: OAUTH_BLOB, source: 'flat-file' }).status).toBe('valid');
  });

  it('a refresh-less blob past its expiry is expired', () => {
    const credential = JSON.stringify({ token: { access_token: 'a', expiry: '2020-01-01T00:00:00Z' } });
    expect(validateLocalAntigravityToken({ method: 'oauth', credential, source: 'flat-file' }).status).toBe('expired');
  });

  it('an API key is valid when present', () => {
    expect(validateLocalAntigravityToken({ method: 'api_key', credential: 'AIza', source: 'flat-file' }).status).toBe('valid');
  });
});
