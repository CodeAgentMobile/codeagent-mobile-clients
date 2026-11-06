/**
 * Unit tests for agy's completed-reply failure classifier (codeagent-6bg9):
 * the banner gate, the log-tail scan (severity, since-the-turn scoping, tail
 * bound) and credential redaction. Behaviour end-to-end through `start_task`
 * is in `__tests__/agents/acp/antigravity-reply-failure.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGY_LOG_TAIL_BYTES,
  antigravityLogDir,
  classifyAntigravityReply,
  recentErrorEntries,
  redactCredentials,
} from '../../../src/agents/antigravity/reply-failure';

const BANNER = '⚠ Agent execution terminated due to error.\n';

function glog(sev: string, at: Date, msg: string): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${sev}${p(at.getMonth() + 1)}${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}:` +
    `${p(at.getSeconds())}.${p(at.getMilliseconds() * 1000, 6)} 233 ${msg}`
  );
}

let home: string;
const env = (): NodeJS.ProcessEnv => ({ HOME: home });
function writeLog(name: string, body: string): string {
  const dir = antigravityLogDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-agy-unit-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('classifyAntigravityReply', () => {
  it('needs agy’s own banner — a bare error text is a real reply', () => {
    expect(classifyAntigravityReply('API key not valid.', { env: env() })).toBeNull();
  });

  it('ignores a long reply that happens to quote the banner', () => {
    const long = `${'Here is what I changed. '.repeat(60)}\n${BANNER}`;
    expect(classifyAntigravityReply(long, { env: env() })).toBeNull();
  });

  it('auth cause in the reply itself → auth without touching the log', () => {
    expect(classifyAntigravityReply(`${BANNER}API key not valid.`, { env: env() })).toBe(
      'auth_failed',
    );
  });

  it.each([
    ['API_KEY_INVALID', 'Error 400, Message: API key not valid., Details: [reason:API_KEY_INVALID]'],
    ['expired key', 'Error 400, Message: API key expired. Please renew the API key.'],
    ['UNAUTHENTICATED', 'Error 401, Message: Request had invalid authentication credentials., Status: UNAUTHENTICATED'],
    ['invalid_grant', 'oauth2: "invalid_grant" "Token has been expired or revoked."'],
    ['PERMISSION_DENIED + key reason', 'Error 403, Status: PERMISSION_DENIED, Details: [reason:API_KEY_SERVICE_BLOCKED]'],
  ])('banner + %s in the newest log → auth_failed', (_label, msg) => {
    const since = Date.now();
    writeLog('acp-server-20261106_181600-233.log', `${glog('E', new Date(), `x.go:1] ${msg}`)}\n`);
    expect(classifyAntigravityReply(BANNER, { env: env(), turnStartedAt: since })).toBe(
      'auth_failed',
    );
  });

  it('PERMISSION_DENIED without a credential reason is NOT auth', () => {
    writeLog(
      'acp-server-20261106_181600-233.log',
      `${glog('E', new Date(), 'x.go:1] Error 403, Status: PERMISSION_DENIED, Details: [reason:SERVICE_DISABLED]')}\n`,
    );
    expect(classifyAntigravityReply(BANNER, { env: env(), turnStartedAt: Date.now() })).toBe(
      'agent_error',
    );
  });

  it('reads the NEWEST acp-server log only', () => {
    const old = writeLog(
      'acp-server-20261105_090000-100.log',
      `${glog('E', new Date(), 'x.go:1] API key not valid')}\n`,
    );
    fs.utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    writeLog('acp-server-20261106_181600-233.log', `${glog('E', new Date(), 'x.go:1] Error 500')}\n`);
    expect(classifyAntigravityReply(BANNER, { env: env() })).toBe('agent_error');
  });

  it('only the last AGY_LOG_TAIL_BYTES are scanned', () => {
    const auth = `${glog('E', new Date(), 'x.go:1] API key not valid')}\n`;
    const filler = `${glog('I', new Date(), `x.go:2] ${'.'.repeat(200)}`)}\n`.repeat(
      Math.ceil((AGY_LOG_TAIL_BYTES * 2) / 230),
    );
    writeLog('acp-server-20261106_181600-233.log', auth + filler);
    expect(classifyAntigravityReply(BANNER, { env: env() })).toBe('agent_error');
  });

  it('missing log dir → agent_error', () => {
    expect(classifyAntigravityReply(BANNER, { env: env() })).toBe('agent_error');
  });
});

describe('recentErrorEntries', () => {
  it('keeps E/F entries with continuation lines, drops I/W and entries before `since`', () => {
    const now = Date.now();
    const tail = [
      'cut-off line from the tail start',
      glog('E', new Date(now - 600_000), 'a.go:1] stale API key not valid'),
      glog('I', new Date(now), 'b.go:1] info'),
      glog('W', new Date(now), 'c.go:1] warn API key not valid'),
      glog('E', new Date(now), 'd.go:1] fresh error'),
      '  continuation detail',
    ].join('\n');
    expect(recentErrorEntries(tail, now - 1_000, now)).toEqual([
      `${glog('E', new Date(now), 'd.go:1] fresh error')}\n  continuation detail`,
    ]);
  });
});

describe('redactCredentials', () => {
  it('masks Google API keys and OAuth access/refresh tokens', () => {
    const out = redactCredentials(
      'key=AIzaSyA1234567890abcdefGHIJ tok=ya29.a0AfH6SMBxyz-123 refresh=1//0gAbCdEfGhIjKlMn',
    );
    expect(out).not.toMatch(/AIzaSyA1234567890|ya29\.a0AfH6|1\/\/0gAbCdEf/);
    expect(out).toContain('[redacted]');
  });
});
