import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMIX_CONTRACT_HEADER,
  _resetRemixContext,
  noteRemixPushResult,
  readRemixProject,
  remixContextForTurn,
  type RemixContextDeps,
} from '../../../src/agents/acp/remix-context';
import { ACP_COMMAND_HANDLERS } from '../../../src/agents/acp/command-handlers';

const CONTRACT = '# This app lives on CodeAgent Remix\n\nEvery push…';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remix-ctx-'));
}

function repo(remix: unknown | null): string {
  const dir = tmp();
  if (remix !== null) fs.writeFileSync(path.join(dir, 'remix.json'), JSON.stringify(remix));
  return dir;
}

function deps(over: Partial<RemixContextDeps> = {}): RemixContextDeps & { fetch: ReturnType<typeof vi.fn> } {
  const cache = tmp();
  return {
    fetch: vi.fn(async () => new Response(CONTRACT, { status: 200 })),
    apiBase: () => 'https://api.example.test/',
    cacheDir: () => cache,
    timeoutMs: 1000,
    ...over,
  } as RemixContextDeps & { fetch: ReturnType<typeof vi.fn> };
}

const FAILED = {
  appId: 'app-1',
  title: 'Pasito',
  repo: 'edgar-durand/pasito',
  sha: '1bb4c78a0000000000000000000000000000beef',
  subject: 'feat: ElevenLabs TTS',
  state: 'failed',
  stage: 'checks',
  reason: "it didn't pass the checks: server/routes/tts.ts: fetch() to api.elevenlabs.io is not declared",
  problems: [
    'server/routes/tts.ts: fetch() to api.elevenlabs.io is not declared — add "api.elevenlabs.io" to "connect" in remix.json, or remove the call.',
  ],
};

describe('Remix context for the agent (owner 2026-11-24)', () => {
  beforeEach(() => _resetRemixContext());
  afterEach(() => _resetRemixContext());

  it('reads a root remix.json; anything else is not a Remix project', () => {
    expect(readRemixProject(repo({ kind: 'MOBILE', server: { entry: 'server/index.ts' } }))).toEqual({ kind: 'MOBILE', server: true });
    expect(readRemixProject(repo({ kind: 'WEB' }))).toEqual({ kind: 'WEB', server: false });
    expect(readRemixProject(repo(null))).toBeNull();
    expect(readRemixProject(repo({ kind: 'NOPE' }))).toBeNull();
  });

  it('gives the contract once per (session, agent) in a Remix repo, fetched once per process', async () => {
    const d = deps();
    const cwd = repo({ kind: 'MOBILE', server: {} });
    const first = await remixContextForTurn('s1', 'claude', cwd, d);
    expect(first).toEqual([`${REMIX_CONTRACT_HEADER}\n\n${CONTRACT}`]);
    expect(d.fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/remix/agent-contract?kind=MOBILE&server=1',
      expect.anything(),
    );
    expect(await remixContextForTurn('s1', 'claude', cwd, d)).toEqual([]);
    // Another agent of the session (a switch) gets it too; the network is not asked again.
    expect(await remixContextForTurn('s1', 'gemini', cwd, d)).toHaveLength(1);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('a repo without remix.json gets nothing and asks nothing', async () => {
    const d = deps();
    expect(await remixContextForTurn('s1', 'claude', repo(null), d)).toEqual([]);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('offline: the cached copy from an earlier run; no copy at all = no piece, retried next turn', async () => {
    const cache = tmp();
    fs.writeFileSync(path.join(cache, 'WEB-static.md'), CONTRACT);
    const offline = deps({ cacheDir: () => cache, fetch: vi.fn(async () => { throw new Error('ENOTFOUND'); }) as never });
    expect(await remixContextForTurn('s1', 'claude', repo({ kind: 'WEB' }), offline)).toHaveLength(1);
    _resetRemixContext();
    const none = deps({ fetch: vi.fn(async () => new Response('nope', { status: 503 })) as never });
    expect(await remixContextForTurn('s1', 'claude', repo({ kind: 'WEB' }), none)).toEqual([]);
  });

  it('a refused push is noted ONCE, read at the start of the next turn, then gone', async () => {
    const d = deps();
    const other = repo(null);
    expect(noteRemixPushResult(FAILED)).toBe('queued');
    expect(noteRemixPushResult(FAILED)).toBe('ignored'); // a redelivery never repeats it
    const [note] = await remixContextForTurn('s1', 'claude', other, d);
    expect(note).toContain('[Remix push refused] Your push 1bb4c78 "feat: ElevenLabs TTS" to edgar-durand/pasito did NOT go live');
    expect(note).toContain('- server/routes/tts.ts: fetch() to api.elevenlabs.io is not declared');
    expect(note).toContain('It stopped at: checks.');
    expect(await remixContextForTurn('s1', 'claude', other, d)).toEqual([]);
    expect(noteRemixPushResult(FAILED)).toBe('ignored'); // never a loop on the same sha
  });

  it('a newer failure of the app replaces a waiting one; live drops it', async () => {
    const d = deps();
    noteRemixPushResult(FAILED);
    noteRemixPushResult({ ...FAILED, sha: '8808f4fa'.padEnd(40, '0'), problems: ["Your app's code is 2.2 MB; the limit is 2 MB."] });
    const pieces = await remixContextForTurn('s1', 'claude', repo(null), d);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toContain('8808f4f');
    noteRemixPushResult({ ...FAILED, sha: 'c'.repeat(40) });
    expect(noteRemixPushResult({ appId: 'app-1', sha: 'd'.repeat(40), state: 'live' })).toBe('cleared');
    expect(await remixContextForTurn('s1', 'claude', repo(null), d)).toEqual([]);
    expect(noteRemixPushResult({ nope: true })).toBe('ignored');
  });

  it('the relay command is handled in ACP mode and acked at once, without starting a turn', async () => {
    const handler = ACP_COMMAND_HANDLERS.remix_push_result;
    expect(handler).toBeTypeOf('function');
    const sendResult = vi.fn(async () => undefined);
    await handler({ cmd: { id: 'c1', type: 'remix_push_result', payload: FAILED }, relay: { sendResult } } as never);
    expect(sendResult).toHaveBeenCalledWith('c1', 'completed', { outcome: 'queued' });
  });
});
