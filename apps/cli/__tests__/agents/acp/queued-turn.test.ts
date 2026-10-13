/**
 * codeagent-u7mm (whait930, 2026-10-13): messages sent while a long turn ran.
 *
 * 1. A queued `start_task` opened its turn on the phone at ONCE —
 *    `beginTurn()` publishes `clear` + `new_turn` — wiping the live turn's
 *    output and reporting itself started half an hour before the agent saw it.
 * 2. After the long turn failed on the idle watchdog, the next queued prompt
 *    reached the adapter BEFORE the failed turn's cleanup `session/cancel`, so
 *    the cancel killed that innocent turn ("agent turn ended with an empty
 *    reply").
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dispatchAcpCommand,
  assembleAcpCommandContext,
  type AcpSessionContext,
} from '../../../src/agents/acp/command-handlers';
import { AcpClient, type AcpClientOptions } from '../../../src/agents/acp/client';
import { TurnQueue } from '../../../src/agents/acp/turn-queue';
import type { RemoteCommand } from '@codeam/shared';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function startTask(text: string, id: string): RemoteCommand {
  return {
    id,
    sessionId: 's1',
    pluginId: 'p1',
    type: 'start_task',
    payload: { prompt: text },
    status: 'pending',
    createdAt: Date.now(),
  } as unknown as RemoteCommand;
}

describe('start_task while another turn runs (u7mm)', () => {
  it('waits, untouched, until the running turn has fully closed', async () => {
    const events: string[] = [];
    const replies = new Map<string, Deferred<{ stopReason: string }>>();
    const client = {
      prompt: vi.fn((blocks: Array<{ type: string; text?: string }>) => {
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const key = text.includes('first') ? 'A' : 'B';
        events.push(`prompt:${key}`);
        const d = defer<{ stopReason: string }>();
        replies.set(key, d);
        return d.promise;
      }),
      cancel: vi.fn(async () => undefined),
    };
    let turn = 0;
    const streaming = {
      turns: new TurnQueue(),
      beginTurn: vi.fn(async () => {
        turn += 1;
        events.push(`beginTurn:${turn}`);
      }),
      getCurrentText: vi.fn(() => 'Done.'),
      hasVisibleProgress: vi.fn(() => true),
      closeTurnWithInteractiveDetection: vi.fn(async () => {
        events.push('close');
        return false;
      }),
      closeWithBubble: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
    };
    const session = {
      client,
      relay: { sendResult: vi.fn(async (id: string) => void events.push(`ack:${id}`)) },
      acpSessionId: 'conv-1',
      streaming,
      opts: { agent: 'opencode', sessionId: 's1', pluginId: 'p1' },
      history: {
        appendUserPrompt: vi.fn(),
        appendAgentReply: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      jsonlHistory: {},
      agentCaps: { loadSession: true },
      turnFiles: { flushTurn: vi.fn(async () => undefined), peekTurnPaths: vi.fn(() => []) },
      getBeads: () => null,
      publisher: { publishOutput: vi.fn(async () => undefined) },
      recentStderr: [],
      budgetRecovery: { offer: vi.fn(), tryRecover: vi.fn(async () => false) },
      budgetReachedFlag: { get: () => false, set: () => undefined },
      pendingProposal: { current: null },
      currentIsHouse: () => false,
    } as unknown as AcpSessionContext;

    const a = dispatchAcpCommand(assembleAcpCommandContext(session, startTask('first task', 'A')));
    await tick();
    const b = dispatchAcpCommand(assembleAcpCommandContext(session, startTask('follow-up', 'B')));
    await tick();
    await tick();
    // B is waiting: no second `new_turn` over A's live output, no prompt.
    expect(events).toEqual(['beginTurn:1', 'prompt:A']);

    replies.get('A')!.resolve({ stopReason: 'end_turn' });
    await a;
    await vi.waitFor(() => expect(events).toContain('prompt:B'));
    // B opens only after A closed and acked.
    expect(events).toEqual([
      'beginTurn:1',
      'prompt:A',
      'close',
      'ack:A',
      'beginTurn:2',
      'prompt:B',
    ]);

    replies.get('B')!.resolve({ stopReason: 'end_turn' });
    await b;
    expect(streaming.turns.busy).toBe(false);
  });
});

describe('AcpClient — a turn the idle watchdog abandons (u7mm)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is cancelled, and answers, before the next queued prompt is sent', async () => {
    vi.useFakeTimers();
    const opts: AcpClientOptions = {
      adapter: {} as unknown as AcpClientOptions['adapter'],
      cwd: '/tmp/work',
      onSessionUpdate: () => undefined,
      onRequestPermission: (async () => ({
        outcome: { outcome: 'cancelled' },
      })) as unknown as AcpClientOptions['onRequestPermission'],
    };
    const client = new AcpClient(opts);
    const wire: string[] = [];
    const stuck = defer<{ stopReason: string }>();
    const connection = {
      prompt: vi.fn((req: { prompt: Array<{ text?: string }> }) => {
        const text = req.prompt.map((p) => p.text ?? '').join('');
        wire.push(`prompt:${text}`);
        return text === 'B' ? stuck.promise : Promise.resolve({ stopReason: 'end_turn' });
      }),
      cancel: vi.fn(async () => {
        wire.push('cancel');
        // The adapter ends the abandoned turn a moment after the cancel.
        setTimeout(() => stuck.resolve({ stopReason: 'cancelled' }), 50);
      }),
    };
    const internals = client as unknown as { connection: unknown; sessionId: string };
    internals.connection = connection;
    internals.sessionId = 'sess-1';

    const pB = client.prompt('B');
    const bFailed = expect(pB).rejects.toThrow(/ACP prompt idle/);
    const pC = client.prompt('C');
    await vi.advanceTimersByTimeAsync(0);
    expect(wire).toEqual(['prompt:B']);

    // B goes silent past the strict idle window: the client cancels it and
    // holds C until the adapter has answered the cancelled turn.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(wire).toEqual(['prompt:B', 'cancel']);

    await vi.advanceTimersByTimeAsync(100);
    await bFailed;
    await expect(pC).resolves.toEqual({ stopReason: 'end_turn' });
    expect(wire).toEqual(['prompt:B', 'cancel', 'prompt:C']);
  });
});
