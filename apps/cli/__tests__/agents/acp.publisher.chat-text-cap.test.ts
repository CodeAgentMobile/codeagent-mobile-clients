import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpPublisher,
  CHAT_TEXT_FALLBACK_MAX_BYTES,
  CHAT_TEXT_MAX_BYTES,
  boundChatText,
} from '../../src/agents/acp/publisher';
import * as transport from '../../src/services/streaming/transport';

/**
 * 2026-10-14: an opencode Box turn's CUMULATIVE reply grew past api-v2's
 * 256 KiB `content` cap on POST /api/commands/output. Every later frame —
 * the terminal done:true included — came back 413 (430 of them, bodies
 * 0.27 → 2.1 MB), and the user never saw the reply. The publisher must never
 * send a text frame over the cap, and must never loop on a 413.
 */
describe('AcpPublisher — chat-pipe text cap', () => {
  let publisher: AcpPublisher;
  let postSpy: ReturnType<typeof vi.spyOn>;
  const bodies = () =>
    (postSpy.mock.calls as unknown[][]).map(
      (c) => JSON.parse(String(c[2])) as { type: string; content?: string; done?: boolean },
    );

  beforeEach(() => {
    publisher = new AcpPublisher({
      sessionId: 'sess-1',
      pluginId: 'plug-1',
      pluginAuthToken: 'tok-1',
      apiBaseUrl: 'https://example.test',
    });
    postSpy = vi.spyOn(transport._transport, 'post').mockResolvedValue({ statusCode: 200, body: '' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('boundChatText keeps head and tail, stays under the byte cap, never splits a code point', () => {
    const reply = 'HEAD ' + '日本🙂'.repeat(200 * 1024) + ' TAIL';
    const out = boundChatText(reply);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(CHAT_TEXT_MAX_BYTES);
    expect(out.content.startsWith('HEAD ')).toBe(true);
    expect(out.content.endsWith(' TAIL')).toBe(true);
    expect(out.content).not.toContain('�');
    expect(boundChatText('small')).toEqual({ content: 'small', truncated: false });
  });

  it('a 2 MB cumulative reply goes out under the cap, partial and terminal', async () => {
    const reply = 'start ' + 'x'.repeat(2 * 1024 * 1024) + ' the conclusion';
    await publisher.publishOutput({ type: 'text', content: reply, done: false });
    await publisher.publishOutput({ type: 'text', content: reply, done: true });
    const sent = bodies();
    expect(sent).toHaveLength(2);
    for (const b of sent) {
      expect(Buffer.byteLength(b.content ?? '', 'utf8')).toBeLessThanOrEqual(CHAT_TEXT_MAX_BYTES);
    }
    expect(sent[1].content?.endsWith('the conclusion')).toBe(true);
  });

  it('a 413 on a partial frame latches: no more partials, but the terminal frame still goes', async () => {
    postSpy.mockResolvedValueOnce({ statusCode: 413, body: '' });
    await publisher.publishOutput({ type: 'text', content: 'a', done: false });
    await publisher.publishOutput({ type: 'text', content: 'ab', done: false });
    await publisher.publishOutput({ type: 'text', content: 'abc', done: false });
    await publisher.publishOutput({ type: 'text', content: 'abcd', done: true });
    expect(bodies().map((b) => [b.content, b.done])).toEqual([
      ['a', false],
      ['abcd', true],
    ]);
    // The next turn streams normally again.
    await publisher.publishOutput({ type: 'new_turn', done: false });
    await publisher.publishOutput({ type: 'text', content: 'next', done: false });
    expect(bodies().at(-1)).toMatchObject({ content: 'next' });
  });

  it('a 413 on the terminal frame is retried ONCE with a shorter reply, never looped', async () => {
    postSpy.mockResolvedValue({ statusCode: 413, body: '' });
    await publisher.publishOutput({ type: 'text', content: 'z'.repeat(100 * 1024), done: true });
    const sent = bodies();
    expect(sent).toHaveLength(2);
    expect(Buffer.byteLength(sent[1].content ?? '', 'utf8')).toBeLessThanOrEqual(
      CHAT_TEXT_FALLBACK_MAX_BYTES,
    );
  });
});
