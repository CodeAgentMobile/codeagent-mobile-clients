/**
 * Regression for the glued-paragraphs bug (bead codeagent-wqpi).
 *
 * Codex emits several `agent_message_chunk` messages in ONE turn, separated
 * by tool calls: '…run every gate.' (msg A) → tools → "I'm resuming at…"
 * (msg B). Every text delta of a turn collapses onto `turnTextChunkId` (the
 * reply-doubling guard) and `reconcileCumulative` appended B's first byte
 * straight onto A's last byte → the user read "gate.I'm resuming" (replay
 * 2026-09-23 viveknimawat S1 f070; also 'endpoint.The', 'syncing.All'). Both
 * feeds carried the glued string, so the boundary can only be restored here.
 *
 * Contract: a text delta under a NEW message id that APPENDS starts a new
 * paragraph; a snapshot re-emit under a new id still reconciles as REPLACE
 * (no doubling); a delta that already begins with whitespace is left alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { StreamingState } from '../../../src/agents/acp/runner';
import { mapSessionUpdate } from '../../../src/agents/acp/mappers';
import { AcpPublisher } from '../../../src/agents/acp/publisher';

function makeState(): { state: StreamingState; lastText: () => string } {
  const publisher = new AcpPublisher({
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    pluginAuthToken: 'tok-1',
    apiBaseUrl: 'https://api.example.test',
  });
  vi.spyOn(publisher, 'publishOutput').mockResolvedValue(undefined);
  const sc = vi.spyOn(publisher, 'publishStreamingChunk').mockResolvedValue(undefined);
  const lastText = (): string => {
    let out = '';
    for (const call of sc.mock.calls) {
      const e = call[0] as { kind: string; content: string };
      if (e.kind === 'text') out = e.content;
    }
    return out;
  };
  return { state: new StreamingState(publisher), lastText };
}

function messageChunk(messageId: string | null, text: string) {
  return {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
  } as unknown as Parameters<typeof mapSessionUpdate>[0];
}

function toolCall(id: string) {
  return {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', kind: 'execute', status: 'completed' },
  } as unknown as Parameters<typeof mapSessionUpdate>[0];
}

/** Drives a turn and returns the reply text as it stood when the turn closed. */
async function runTurn(
  state: StreamingState,
  notes: Parameters<typeof mapSessionUpdate>[0][],
): Promise<string> {
  await state.beginTurn({ clear: false });
  for (const note of notes) for (const delta of mapSessionUpdate(note)) state.append(delta);
  const text = state.getCurrentText();
  await state.closeAll();
  return text;
}

describe('ACP text — a new message after a finished sentence is a new paragraph', () => {
  it('two Codex messages around a tool call render as two paragraphs, not glued', async () => {
    const { state, lastText } = makeState();
    const text = await runTurn(state, [
      messageChunk('msg-A', "I'll run every "),
      messageChunk('msg-A', 'gate.'),
      toolCall('call-1'),
      messageChunk('msg-B', "I'm resuming at the audit step."),
    ]);
    expect(text).toBe("I'll run every gate.\n\nI'm resuming at the audit step.");
    expect(lastText()).not.toContain("gate.I'm");
  });

  it('a full re-emit of the same reply under a 2nd message id still collapses (no doubling)', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [
      messageChunk('msg-A', 'Hello '),
      messageChunk('msg-A', 'there.'),
      messageChunk('msg-B', 'Hello there.'),
    ]);
    expect(text).toBe('Hello there.');
  });

  it('a new message that already starts with whitespace gets no extra break', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [messageChunk('a', 'Done.'), messageChunk('b', '\n\nNext step.')]);
    expect(text).toBe('Done.\n\nNext step.');
  });

  it('same-message deltas keep streaming byte-for-byte', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [messageChunk('m', 'v1.2.'), messageChunk('m', 'Final')]);
    expect(text).toBe('v1.2.Final');
  });
});

/**
 * Antigravity (agy) sends `agent_message_chunk` WITHOUT a `messageId`. The
 * mapper used to mint a UUID per chunk, so every chunk read as a new message
 * and got a paragraph break: "confirm" / "ados", "`feat: text-to" / "-speech",
 * and orphaned path lines ("durand/pasito.git`") the API lifted into "read"
 * file cards (owner's codespace, 2026-11-24). The exact delta sequence from
 * that turn's CLI log must render as ONE markdown message, byte-for-byte.
 */
describe('ACP text — an agent without message ids streams one message', () => {
  const AGY_DELTAS = [
    'Los cambios ya fueron confirm',
    'ados y subidos a `main`:\n\n- **Commit:** `c256c30` (`feat: text-to',
    '-speech, resumen de habitos y suite de pruebas`)\n- **Repositorio:** `https://github.com/edgar-',
    'durand/pasito.git`\n- **Archivos actualizados:**\n  - `src/utils/speech.ts` (',
    'Text-to-Speech)\n  - `src/components/TaskCard.tsx` (Botón de audio por',
    ' tarea)\n  - `src/screens/parent/ParentHome.tsx` (Métricas de hábitos)\n  ',
    '- `src/theme.ts` (Estilo `bodyBold`)\n  - `scripts/test-smoke',
    '.js` y `package.json` (Script de pruebas)',
  ];

  it('the 2026-11-24 agy reply is the plain concatenation of its deltas', async () => {
    const { state, lastText } = makeState();
    const text = await runTurn(
      state,
      AGY_DELTAS.map((d) => messageChunk(null, d)),
    );
    expect(text).toBe(AGY_DELTAS.join(''));
    expect(lastText()).toBe(AGY_DELTAS.join(''));
    expect(text).not.toContain('confirm\n\nados');
    expect(text).toContain('`https://github.com/edgar-durand/pasito.git`');
  });

  it('an absent messageId (undefined, not null) is the same single stream', async () => {
    const { state } = makeState();
    const note = (text: string) =>
      ({
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      }) as unknown as Parameters<typeof mapSessionUpdate>[0];
    const text = await runTurn(state, [note('Los cambios ya fueron confirm'), note('ados.')]);
    expect(text).toBe('Los cambios ya fueron confirmados.');
  });

  it('text after a tool call is still a new paragraph without message ids', async () => {
    const { state } = makeState();
    const text = await runTurn(state, [
      messageChunk(null, 'Checking the '),
      messageChunk(null, 'files.'),
      toolCall('call_104'),
      messageChunk(null, 'Found it.'),
    ]);
    expect(text).toBe('Checking the files.\n\nFound it.');
  });
});
