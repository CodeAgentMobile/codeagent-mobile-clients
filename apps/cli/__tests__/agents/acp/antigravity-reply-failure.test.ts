/**
 * Regression (codeagent-6bg9) — Antigravity (`agy acp`) reports a provider /
 * auth failure as a NORMAL completed turn. Live capture (CodeAgent Box, agy
 * 1.5.2, GEMINI_API_KEY = an invalid key, 2026-11-06): the ONLY streamed text is
 * `⚠ Agent execution terminated due to error.\n`, `session/prompt` resolves
 * `{"stopReason":"end_turn"}`, nothing on stderr. The cause is only in agy's
 * own log, `~/.gemini/antigravity-cli/log/acp-server-<ts>-<pid>.log`.
 *
 * Before the fix the banner was rendered as the agent's reply: no re-auth
 * bubble, credential never flagged invalid. The fixtures reproduce that exact
 * shape — banner-only reply, the detail in a fake agy log in a tmp HOME.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import {
  StreamingState,
  handleCommand,
  AUTH_FAILURE_MESSAGE,
  TURN_FAILURE_MESSAGE,
} from '../../../src/agents/acp/runner';
import {
  resetCurrentAgentEnvForTests,
  setCurrentAgentEnv,
} from '../../../src/agents/current-agent-env';

vi.mock('../../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

/** Exactly what agy streams on a failed turn — nothing else. */
const AGY_BANNER = '⚠ Agent execution terminated due to error.\n';

/** glog prefix for `at` in local time, like agy writes it. */
function glog(sev: string, at: Date, msg: string): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const ts =
    `${p(at.getMonth() + 1)}${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}:` +
    `${p(at.getSeconds())}.${p(at.getMilliseconds() * 1000, 6)}`;
  return `${sev}${ts} 233 ${msg}`;
}

/** The real entry agy 1.5.2 logged for an invalid GEMINI_API_KEY. */
const INVALID_KEY_ENTRY =
  'errorreport.go:247] agent executor error: generating and executing: Error 400, Message: ' +
  'API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: ' +
  '[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID",' +
  '"domain":"googleapis.com"}]';
const NON_AUTH_ENTRY =
  'errorreport.go:247] agent executor error: generating and executing: Error 500, Message: ' +
  'Internal error encountered., Status: INTERNAL';

let home: string;

/** Append agy log lines to the newest acp-server log in the tmp HOME. */
function writeAgyLog(lines: string[]): void {
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'log');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'acp-server-20261106_181600-233.log'),
    lines.map((l) => `${l}\n`).join(''),
  );
}

type OutputCall = { type?: string; content?: string; done?: boolean };

function makeHarness(agent: string, replyText: string, onPrompt?: () => void) {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  const publishOutput = vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushConversation').mockResolvedValue(undefined);
  vi.spyOn(publisher, 'pushSessionList').mockResolvedValue(undefined);
  const streaming = new StreamingState(publisher);

  // agy streams the error as an ordinary chunk, then ends the turn cleanly.
  const client = {
    prompt: vi.fn(async () => {
      // agy writes the cause to its log DURING the turn, then streams the banner.
      onPrompt?.();
      streaming.append({ chunkId: 'msg-1', kind: 'text', delta: replyText });
      return { stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => undefined),
  };
  const sendResult = vi.fn(async () => undefined);
  const opts = {
    agent,
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    adapter: { command: 'noop', args: [] },
    cwd: '/tmp',
  };
  const terminalTextFrames = (): OutputCall[] =>
    publishOutput.mock.calls
      .map((c) => c[0] as OutputCall)
      .filter((b) => b.type === 'text' && b.done === true);

  const run = () =>
    handleCommand(
      { id: 'cmd-1', type: 'start_task', payload: { prompt: 'hi' } } as never,
      client as never,
      { sendResult } as never,
      'acp-sess-1',
      streaming,
      opts as never,
      {
        appendUserPrompt: vi.fn(),
        appendAgentReply: vi.fn(),
        flush: vi.fn(async () => undefined),
      } as never,
      { uploadConversationIfChanged: vi.fn(async () => undefined) } as never,
      undefined,
      { flushTurn: vi.fn(async () => undefined), peekTurnPaths: vi.fn(() => []) } as never,
      () => null,
      publisher,
      [],
    );
  return { run, sendResult, terminalTextFrames };
}

describe('Antigravity — provider errors streamed as a completed reply', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const credentialInvalidPosted = (): boolean =>
    fetchSpy.mock.calls.some((c) => /\/credential-invalid$/.test(String(c[0])));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-agy-'));
    setCurrentAgentEnv({ HOME: home });
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    resetCurrentAgentEnvForTests();
    fs.rmSync(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('invalid API key (cause only in agy\'s log) → re-auth bubble + credential flagged invalid', async () => {
    const { run, sendResult, terminalTextFrames } = makeHarness('antigravity', AGY_BANNER, () =>
      writeAgyLog([
        glog('I', new Date(), 'server.go:88] session/prompt'),
        glog('E', new Date(), INVALID_KEY_ENTRY),
      ]),
    );
    await run();
    await new Promise((r) => setImmediate(r));
    const finals = terminalTextFrames();
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(AUTH_FAILURE_MESSAGE);
    expect(credentialInvalidPosted()).toBe(true);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'failed', expect.any(Object));
  });

  it('a non-auth agy error → honest generic failure, credential untouched', async () => {
    const { run, sendResult, terminalTextFrames } = makeHarness('antigravity', AGY_BANNER, () =>
      writeAgyLog([glog('E', new Date(), NON_AUTH_ENTRY)]),
    );
    await run();
    await new Promise((r) => setImmediate(r));
    const finals = terminalTextFrames();
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(TURN_FAILURE_MESSAGE);
    expect(credentialInvalidPosted()).toBe(false);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'failed', expect.any(Object));
  });

  it('an auth error from an EARLIER turn does not reclassify a new generic failure', async () => {
    // Logged 10 minutes before this turn started (since fixed by a re-link).
    writeAgyLog([glog('E', new Date(Date.now() - 10 * 60_000), INVALID_KEY_ENTRY)]);
    const { run, terminalTextFrames } = makeHarness('antigravity', AGY_BANNER, () =>
      writeAgyLog([glog('E', new Date(), NON_AUTH_ENTRY)]),
    );
    await run();
    await new Promise((r) => setImmediate(r));
    expect(terminalTextFrames()[0].content).toBe(TURN_FAILURE_MESSAGE);
    expect(credentialInvalidPosted()).toBe(false);
  });

  it('no agy log at all → generic failure (never a silent raw banner)', async () => {
    const { run, terminalTextFrames } = makeHarness('antigravity', AGY_BANNER);
    await run();
    await new Promise((r) => setImmediate(r));
    expect(terminalTextFrames()[0].content).toBe(TURN_FAILURE_MESSAGE);
    expect(credentialInvalidPosted()).toBe(false);
  });

  it('a normal reply that merely discusses an invalid API key is NOT misclassified', async () => {
    const reply =
      'The 400 you saw comes from the Maps client: "API key not valid" means the key in ' +
      '.env is wrong. I updated `config.ts` to read MAPS_API_KEY instead.';
    const { run, sendResult, terminalTextFrames } = makeHarness('antigravity', reply, () =>
      writeAgyLog([glog('E', new Date(), INVALID_KEY_ENTRY)]),
    );
    await run();
    await new Promise((r) => setImmediate(r));
    expect(terminalTextFrames().some((f) => f.content === AUTH_FAILURE_MESSAGE)).toBe(false);
    expect(credentialInvalidPosted()).toBe(false);
    expect(sendResult).not.toHaveBeenCalledWith('cmd-1', 'failed', expect.anything());
  });

  it('the same banner on another agent is left alone (scoped to antigravity)', async () => {
    const { run, terminalTextFrames } = makeHarness('claude', AGY_BANNER, () =>
      writeAgyLog([glog('E', new Date(), INVALID_KEY_ENTRY)]),
    );
    await run();
    await new Promise((r) => setImmediate(r));
    expect(terminalTextFrames().some((f) => f.content === AUTH_FAILURE_MESSAGE)).toBe(false);
    expect(credentialInvalidPosted()).toBe(false);
  });
});
