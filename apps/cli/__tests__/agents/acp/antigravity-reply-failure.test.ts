/**
 * Regression (codeagent-6bg9) — Antigravity (`agy acp`) reports a provider /
 * auth failure as a NORMAL agent message chunk ("⚠ Agent execution terminated
 * due to error." + the provider's detail) followed by a clean `end_turn`, not a
 * JSON-RPC error. None of the throw/exit failure paths see it, so before the
 * fix the raw text was rendered as the agent's reply: no re-auth bubble, and
 * the LinkedAgent credential was never flagged invalid.
 *
 * Observed when agy was added: a fake API key fails the turn with text that
 * includes "API key not valid". The fixtures below reproduce that shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpPublisher } from '../../../src/agents/acp/publisher';
import {
  StreamingState,
  handleCommand,
  AUTH_FAILURE_MESSAGE,
  TURN_FAILURE_MESSAGE,
} from '../../../src/agents/acp/runner';
import { classifyAntigravityReply } from '../../../src/agents/acp/agent-hooks';

vi.mock('../../../src/services/pairing.service', () => ({
  postTurnEvent: vi.fn().mockResolvedValue(undefined),
  fetchCurrentPluginAuthToken: vi.fn(),
  _postJsonAuthed: vi.fn(),
}));

const AGY_INVALID_KEY =
  '⚠ Agent execution terminated due to error.\n\n' +
  'API key not valid. Please pass a valid API key.';
const AGY_EXPIRED_OAUTH =
  '⚠ Agent execution terminated due to error.\n\n' +
  'Request had invalid authentication credentials. Expected OAuth 2 access token, ' +
  'login cookie or other valid authentication credential.';
const AGY_GENERIC_ERROR = '⚠ Agent execution terminated due to error.';

type OutputCall = { type?: string; content?: string; done?: boolean };

function makeHarness(agent: string, replyText: string) {
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
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['invalid API key', AGY_INVALID_KEY],
    ['expired OAuth token', AGY_EXPIRED_OAUTH],
  ])('%s → re-auth bubble + credential flagged invalid', async (_label, text) => {
    const { run, sendResult, terminalTextFrames } = makeHarness('antigravity', text);
    await run();
    await new Promise((r) => setImmediate(r));
    const finals = terminalTextFrames();
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(AUTH_FAILURE_MESSAGE);
    expect(credentialInvalidPosted()).toBe(true);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'failed', expect.any(Object));
  });

  it('a non-auth "execution terminated" → honest generic failure, credential untouched', async () => {
    const { run, sendResult, terminalTextFrames } = makeHarness('antigravity', AGY_GENERIC_ERROR);
    await run();
    await new Promise((r) => setImmediate(r));
    const finals = terminalTextFrames();
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe(TURN_FAILURE_MESSAGE);
    expect(credentialInvalidPosted()).toBe(false);
    expect(sendResult).toHaveBeenCalledWith('cmd-1', 'failed', expect.any(Object));
  });

  it('a normal reply that merely discusses an invalid API key is NOT misclassified', async () => {
    const reply =
      'The 400 you saw comes from the Maps client: "API key not valid" means the key in ' +
      '.env is wrong. I updated `config.ts` to read MAPS_API_KEY instead.';
    const { run, sendResult, terminalTextFrames } = makeHarness('antigravity', reply);
    await run();
    await new Promise((r) => setImmediate(r));
    expect(terminalTextFrames().some((f) => f.content === AUTH_FAILURE_MESSAGE)).toBe(false);
    expect(credentialInvalidPosted()).toBe(false);
    expect(sendResult).not.toHaveBeenCalledWith('cmd-1', 'failed', expect.anything());
  });
});

describe('classifyAntigravityReply', () => {
  it('needs agy’s own termination marker', () => {
    expect(classifyAntigravityReply('API key not valid. Please pass a valid API key.')).toBeNull();
  });
  it('classifies auth vs generic termination', () => {
    expect(classifyAntigravityReply(AGY_INVALID_KEY)).toBe('auth_failed');
    expect(classifyAntigravityReply(AGY_EXPIRED_OAUTH)).toBe('auth_failed');
    expect(classifyAntigravityReply(AGY_GENERIC_ERROR)).toBe('agent_error');
  });
  it('ignores a long reply that happens to quote the marker', () => {
    const long = `${'Here is what I changed. '.repeat(60)}\n${AGY_GENERIC_ERROR}`;
    expect(classifyAntigravityReply(long)).toBeNull();
  });
});
