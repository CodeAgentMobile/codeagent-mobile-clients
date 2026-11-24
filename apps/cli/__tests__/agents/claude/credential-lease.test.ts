import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_LEASE_LEAD_MS,
  createClaudeCredentialLease,
  localClaudeRefreshTokenSha256,
} from '../../../src/agents/claude/credential-lease';

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

function blob(at: string, rt: string, expiresInMs: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: at,
      refreshToken: rt,
      expiresAt: NOW + expiresInMs,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
    ...extra,
  });
}

/** One "box": its own HOME with a Claude credentials file. */
function makeBox(initial: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-lease-'));
  const file = path.join(dir, '.credentials.json');
  fs.writeFileSync(file, initial, { mode: 0o600 });
  return {
    dir,
    file,
    read: () =>
      JSON.parse(fs.readFileSync(file, 'utf8')) as {
        claudeAiOauth: Record<string, unknown>;
        [k: string]: unknown;
      },
  };
}

/**
 * The server side of the protocol, modelled: one vault, one per-user lock, and
 * a fake Anthropic token endpoint with REAL single-use semantics (a reused
 * refresh token answers invalid_grant). Mirrors `AgentCredentialRefreshService`.
 */
function makeServer(initial: string) {
  let vault = initial;
  const spent = new Set<string>();
  const endpointCalls: string[] = [];
  let invalidGrants = 0;
  let n = 1;
  let lock: Promise<void> = Promise.resolve();

  const tokenEndpoint = async (rt: string): Promise<string> => {
    endpointCalls.push(rt);
    await new Promise((r) => setTimeout(r, 5));
    if (spent.has(rt)) {
      invalidGrants += 1;
      throw new Error('invalid_grant');
    }
    spent.add(rt);
    n += 1;
    return blob(`at-${n}`, `rt-${n}`, 8 * 60 * MIN);
  };

  const lease = (minValidityMs: number): Promise<string> => {
    const run = lock.then(async () => {
      const oauth = (
        JSON.parse(vault) as { claudeAiOauth: { refreshToken: string; expiresAt: number } }
      ).claudeAiOauth;
      if (oauth.expiresAt - NOW > minValidityMs) return vault;
      vault = await tokenEndpoint(oauth.refreshToken);
      return vault;
    });
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    lease,
    get vault() {
      return vault;
    },
    endpointCalls,
    get invalidGrants() {
      return invalidGrants;
    },
  };
}

describe('Claude credential lease (codeagent-3570)', () => {
  const boxes: string[] = [];
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of boxes.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('two boxes and a deploy needing a refresh at once: ONE rotation, both boxes end on it, no invalid_grant', async () => {
    // Both boxes were handed the same credential, 3 min from expiry: the moment
    // both of their own Claudes would refresh with the same single-use token.
    const shared = blob('at-1', 'rt-1', 3 * MIN);
    const server = makeServer(shared);
    const a = makeBox(shared);
    const b = makeBox(shared);
    boxes.push(a.dir, b.dir);
    const leaseA = createClaudeCredentialLease({
      sessionId: 's-a',
      pluginId: 'p-a',
      pluginAuthToken: 't',
      credentialsPaths: () => [a.file],
      fetchLease: server.lease,
    });
    const leaseB = createClaudeCredentialLease({
      sessionId: 's-b',
      pluginId: 'p-b',
      pluginAuthToken: 't',
      credentialsPaths: () => [b.file],
      fetchLease: server.lease,
    });

    await Promise.all([
      leaseA.ensureFresh(),
      leaseB.ensureFresh(),
      server.lease(5 * MIN), // a deploy injecting at the same time
    ]);

    expect(server.endpointCalls).toEqual(['rt-1']);
    expect(server.invalidGrants).toBe(0);
    for (const box of [a, b]) {
      const oauth = box.read().claudeAiOauth;
      expect(oauth.refreshToken).toBe('rt-2');
      expect(oauth.accessToken).toBe('at-2');
      expect(oauth.expiresAt).toBe(NOW + 8 * 60 * MIN);
    }
  });

  it('a box whose token another holder already rotated never presents the spent one', async () => {
    const shared = blob('at-1', 'rt-1', 50 * MIN);
    const server = makeServer(shared);
    const a = makeBox(shared);
    const b = makeBox(shared);
    boxes.push(a.dir, b.dir);
    const mk = (file: string) =>
      createClaudeCredentialLease({
        sessionId: 's',
        pluginId: 'p',
        pluginAuthToken: 't',
        credentialsPaths: () => [file],
        fetchLease: server.lease,
      });

    await mk(a.file).ensureFresh(); // box A's turn rotates rt-1 → rt-2
    expect(b.read().claudeAiOauth.refreshToken).toBe('rt-1'); // box B still holds the spent one
    await mk(b.file).ensureFresh(); // box B's next turn

    expect(server.endpointCalls).toEqual(['rt-1']);
    expect(b.read().claudeAiOauth.refreshToken).toBe('rt-2');
  });

  it('leaves a fresh credential alone and does not re-read it on every agent event', async () => {
    const box = makeBox(blob('at-1', 'rt-1', 3 * 60 * MIN));
    boxes.push(box.dir);
    const fetchLease = vi.fn();
    const paths = vi.fn(() => [box.file]);
    const lease = createClaudeCredentialLease({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      credentialsPaths: paths,
      fetchLease,
    });

    await lease.duringTurn(async () => {
      for (let i = 0; i < 50; i++) lease.onAgentActivity();
    });

    expect(fetchLease).not.toHaveBeenCalled();
    expect(paths).toHaveBeenCalledTimes(1);
  });

  it('keeps every other field of the file, and writes it 0600', async () => {
    const box = makeBox(blob('at-1', 'rt-1', 2 * MIN, { mcpOAuth: { srv: { token: 'x' } } }));
    boxes.push(box.dir);
    const lease = createClaudeCredentialLease({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      credentialsPaths: () => [box.file],
      // The server's blob carries its own subscriptionType guess; the box's wins.
      fetchLease: async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'at-2',
            refreshToken: 'rt-2',
            expiresAt: NOW + 8 * 60 * MIN,
            scopes: ['user:inference'],
            subscriptionType: 'pro',
          },
        }),
    });

    await lease.ensureFresh();

    const written = box.read();
    expect(written.mcpOAuth).toEqual({ srv: { token: 'x' } });
    expect(written.claudeAiOauth.subscriptionType).toBe('max');
    expect(written.claudeAiOauth.refreshToken).toBe('rt-2');
    expect(fs.statSync(box.file).mode & 0o777).toBe(0o600);
  });

  it('leases on agent activity only while a turn runs', async () => {
    const box = makeBox(blob('at-1', 'rt-1', 3 * 60 * MIN));
    boxes.push(box.dir);
    const fetchLease = vi.fn(async () => blob('at-2', 'rt-2', 8 * 60 * MIN));
    const lease = createClaudeCredentialLease({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      credentialsPaths: () => [box.file],
      fetchLease,
    });
    await lease.ensureFresh(); // caches a 3 h expiry

    // Time passes to inside the lead.
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 3 * 60 * MIN - CLAUDE_LEASE_LEAD_MS + MIN);
    lease.onAgentActivity(); // idle box: no turn → nothing
    await Promise.resolve();
    expect(fetchLease).not.toHaveBeenCalled();

    await lease.duringTurn(async () => {
      lease.onAgentActivity();
      lease.onAgentActivity();
    });
    expect(fetchLease).toHaveBeenCalledTimes(1); // the turn's own lease; activity joined it
    expect(fetchLease).toHaveBeenCalledWith(CLAUDE_LEASE_LEAD_MS);
  });

  it('server unreachable: the file is left alone (Claude falls back to its own refresh)', async () => {
    const original = blob('at-1', 'rt-1', 2 * MIN);
    const box = makeBox(original);
    boxes.push(box.dir);
    const lease = createClaudeCredentialLease({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      credentialsPaths: () => [box.file],
      fetchLease: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(lease.ensureFresh()).resolves.toBeUndefined();
    expect(fs.readFileSync(box.file, 'utf8')).toBe(original);
  });

  it('does nothing without an OAuth login (setup-token / house proxy)', async () => {
    const box = makeBox('{"someOtherKey":true}');
    boxes.push(box.dir);
    const fetchLease = vi.fn();
    const lease = createClaudeCredentialLease({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      credentialsPaths: () => [box.file],
      fetchLease,
    });

    await lease.ensureFresh();
    expect(fetchLease).not.toHaveBeenCalled();
  });

  it('recover() leases even a fresh-looking credential (the server said it is spent)', async () => {
    const box = makeBox(blob('at-1', 'rt-1', 3 * 60 * MIN));
    boxes.push(box.dir);
    const lease = createClaudeCredentialLease({
      sessionId: 's',
      pluginId: 'p',
      pluginAuthToken: 't',
      credentialsPaths: () => [box.file],
      fetchLease: async () => blob('at-9', 'rt-9', 2 * 60 * MIN),
    });

    await lease.recover();
    expect(box.read().claudeAiOauth.refreshToken).toBe('rt-9');
  });

  it('localClaudeRefreshTokenSha256 hashes the refresh token, never returns it', () => {
    const box = makeBox(blob('at-1', 'rt-1', MIN));
    boxes.push(box.dir);
    expect(localClaudeRefreshTokenSha256(() => [box.file])).toBe(
      createHash('sha256').update('rt-1').digest('hex'),
    );
    expect(localClaudeRefreshTokenSha256(() => [path.join(box.dir, 'missing.json')])).toBeNull();
  });
});
