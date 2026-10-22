/**
 * opencode keeps a turn open forever after a terminal provider error: it logs
 * `message="stream error"` and retries, but never answers the ACP prompt. On
 * 2026-10-22 OpenCode Zen's free quota ran out for every Box (they share one
 * egress IP) and each message hung 90 s, then failed with the generic idle
 * bubble. The client now ends the turn on the first such stderr line, cancels
 * it (opencode would keep retrying), and the bubble names the real cause.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/agents/acp/idleTimeout', () => ({
  createIdleTimeout: () => ({
    promise: new Promise<never>(() => {}),
    bump: () => {},
    suspend: () => {},
    clear: () => {},
  }),
}));

import { AcpClient, agentErrorOf, type AcpClientOptions } from '../../src/agents/acp/client';
import { OPENCODE_FATAL_TURN_STDERR_RE, getAcpAdapter } from '../../src/agents/acp/adapters';
import { AGENT_FREE_LIMIT_MESSAGE, failureBubble } from '../../src/agents/acp/failure-messages';

// Verbatim from a Box's `opencode acp --print-logs --log-level ERROR` (2026-10-22).
const FREE_LIMIT_LINE =
  'timestamp=2026-10-22T21:38:33.582Z level=ERROR run=fc660dd6 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_e9a72d54bffeSlhGZ7xjQunKvi small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go"';
const RATE_LIMIT_LINE =
  'timestamp=2026-10-22T21:38:33.582Z level=ERROR run=fc660dd6 message="stream error" providerID=openrouter modelID=x session.id=ses_1 error.error="AI_APICallError: Rate limit exceeded, retry in 10s"';
const SERVER_ERROR_LINE =
  'timestamp=2026-10-22T21:38:33.582Z level=ERROR run=fc660dd6 message="stream error" providerID=anthropic modelID=x session.id=ses_1 error.error="AI_APICallError: Internal server error"';

interface ClientInternals {
  connection: {
    prompt: (p: unknown) => Promise<unknown>;
    cancel: (p: unknown) => Promise<void>;
  } | null;
  sessionId: string | null;
  fatalTurnStderr: RegExp | null;
  onAdapterStderrLine(line: string): void;
}

function clientWithOpenTurn() {
  const client = new AcpClient({
    adapter: { command: 'opencode', args: [] },
    cwd: '/tmp',
    onSessionUpdate: () => {},
  } as unknown as AcpClientOptions);
  const internals = client as unknown as ClientInternals;
  let answer: (v: unknown) => void = () => {};
  const cancel = vi.fn(async () => answer({ stopReason: 'cancelled' }));
  internals.connection = {
    // Never answers on its own — exactly what opencode does after the error.
    prompt: () => new Promise((resolve) => (answer = resolve)),
    cancel,
  };
  internals.sessionId = 'ses_1';
  internals.fatalTurnStderr = OPENCODE_FATAL_TURN_STDERR_RE;
  return { client, internals, cancel };
}

describe('opencode fatal turn errors', () => {
  it('the pattern catches terminal errors only', () => {
    expect(OPENCODE_FATAL_TURN_STDERR_RE.test(FREE_LIMIT_LINE)).toBe(true);
    expect(
      OPENCODE_FATAL_TURN_STDERR_RE.test(
        FREE_LIMIT_LINE.replace(
          /error\.error="[^"]+"/,
          'error.error="AI_APICallError: Invalid API key"',
        ),
      ),
    ).toBe(true);
    // opencode retries these on its own; ending the turn would cut a recovery.
    expect(OPENCODE_FATAL_TURN_STDERR_RE.test(RATE_LIMIT_LINE)).toBe(false);
    expect(OPENCODE_FATAL_TURN_STDERR_RE.test(SERVER_ERROR_LINE)).toBe(false);
  });

  it('pulls the agent error out of the log line', () => {
    expect(agentErrorOf(FREE_LIMIT_LINE)).toBe(
      'AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go',
    );
    expect(agentErrorOf('plain text')).toBe('plain text');
  });

  it('ends the turn on the first fatal line and cancels it', async () => {
    const { client, internals, cancel } = clientWithOpenTurn();
    const turn = client.prompt('hola');
    await new Promise((r) => setImmediate(r));
    internals.onAdapterStderrLine(FREE_LIMIT_LINE);
    await expect(turn).rejects.toThrow(
      /^AGENT_TURN_FAILED: AI_APICallError: Free usage limit reached/,
    );
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'ses_1' });
  });

  it('a retryable error leaves the turn running', async () => {
    const { client, internals, cancel } = clientWithOpenTurn();
    let settled = false;
    const turn = client.prompt('hola').finally(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    internals.onAdapterStderrLine(RATE_LIMIT_LINE);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    internals.onAdapterStderrLine(FREE_LIMIT_LINE);
    await expect(turn).rejects.toThrow(/AGENT_TURN_FAILED/);
  });

  it('a fatal line outside a turn is only logged', () => {
    const { internals } = clientWithOpenTurn();
    expect(() => internals.onAdapterStderrLine(FREE_LIMIT_LINE)).not.toThrow();
  });

  it('the bubble names the free limit and the ways forward', () => {
    const bubble = failureBubble({
      detail: `AGENT_TURN_FAILED: ${agentErrorOf(FREE_LIMIT_LINE)}`,
      recentStderr: FREE_LIMIT_LINE,
      hadText: false,
      agent: 'opencode',
      env: {},
    });
    expect(bubble).toBe(AGENT_FREE_LIMIT_MESSAGE);
    expect(bubble).toContain('Profile › Agents');
  });

  it('a partial reply still gets the free-limit bubble', () => {
    expect(
      failureBubble({
        detail: 'AGENT_TURN_FAILED: Free usage limit reached.',
        recentStderr: '',
        hadText: true,
        agent: 'opencode',
        env: {},
      }),
    ).toBe(AGENT_FREE_LIMIT_MESSAGE);
  });

  it('opencode is launched with its errors on stderr and the fatal pattern', () => {
    const spec = getAcpAdapter('opencode');
    expect(spec?.args).toEqual(['acp', '--print-logs', '--log-level', 'ERROR']);
    expect(spec?.fatalTurnStderr).toBe(OPENCODE_FATAL_TURN_STDERR_RE);
  });
});
