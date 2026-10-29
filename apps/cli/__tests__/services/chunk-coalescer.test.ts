import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingChunkEvent } from '@codeam/shared';
import {
  STREAMING_CHUNK_MIN_INTERVAL_MS,
  StreamingChunkCoalescer,
} from '../../src/services/streaming/chunk-coalescer';

/**
 * 2026-10-29 p99 alert: one CLI posted 10–30 cumulative streaming-chunk
 * snapshots per second for the same chunkId. The coalescer keeps latest-wins,
 * one request in flight and ≥100 ms spacing per chunkId, and always delivers
 * the final frame last.
 */

interface Sent {
  event: StreamingChunkEvent;
  resolve: () => void;
}

function harness(opts: { autoResolve: boolean; latencyMs?: number }) {
  const sent: Sent[] = [];
  const send = vi.fn((event: StreamingChunkEvent) => {
    return new Promise<void>((resolve) => {
      sent.push({ event, resolve });
      if (opts.autoResolve) {
        if (opts.latencyMs) setTimeout(resolve, opts.latencyMs);
        else resolve();
      }
    });
  });
  const coalescer = new StreamingChunkCoalescer({ send });
  return { sent, send, coalescer };
}

const chunk = (chunkId: string, content: string, isFinal = false): StreamingChunkEvent => ({
  chunkId,
  kind: 'text',
  content,
  isFinal,
});

describe('StreamingChunkCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first snapshot of a chunk immediately', async () => {
    const { sent, coalescer } = harness({ autoResolve: true });
    void coalescer.submit(chunk('a', 'h'));
    expect(sent).toHaveLength(1);
    expect(sent[0].event.content).toBe('h');
  });

  it('a burst of 30 updates becomes a few posts, the last one carrying the last content', async () => {
    const { sent, coalescer } = harness({ autoResolve: true });
    let content = '';
    for (let i = 0; i < 30; i++) {
      content += `w${i} `;
      void coalescer.submit(chunk('a', content));
    }
    await vi.advanceTimersByTimeAsync(STREAMING_CHUNK_MIN_INTERVAL_MS * 2);
    expect(sent).toHaveLength(2); // the first one at once + one trailing
    expect(sent[1].event.content).toBe(content);
  });

  it('done is always delivered, after the in-flight post, and is the last post', async () => {
    const { sent, coalescer } = harness({ autoResolve: false });
    void coalescer.submit(chunk('a', 'one'));
    void coalescer.submit(chunk('a', 'one two'));
    let finalSettled = false;
    const done = coalescer.submit(chunk('a', 'one two three', true)).then(() => {
      finalSettled = true;
    });
    void coalescer.submit(chunk('a', 'stale after final'));
    await vi.advanceTimersByTimeAsync(1000);
    // Still only the first request: the final waits for it.
    expect(sent).toHaveLength(1);
    expect(finalSettled).toBe(false);
    sent[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1].event).toEqual(chunk('a', 'one two three', true));
    sent[1].resolve();
    await done;
    expect(finalSettled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
  });

  it('the final skips the spacing wait (no added latency at the end of a message)', async () => {
    const { sent, coalescer } = harness({ autoResolve: true });
    void coalescer.submit(chunk('a', 'x'));
    void coalescer.submit(chunk('a', 'xy'));
    await vi.advanceTimersByTimeAsync(0);
    void coalescer.submit(chunk('a', 'xyz', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.event.content)).toEqual(['x', 'xyz']);
    expect(sent[1].event.isFinal).toBe(true);
  });

  it('in-flight + newer snapshots → only the latest goes out after the in-flight one', async () => {
    const { sent, coalescer } = harness({ autoResolve: false });
    void coalescer.submit(chunk('a', '1'));
    void coalescer.submit(chunk('a', '12'));
    void coalescer.submit(chunk('a', '123'));
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toHaveLength(1);
    sent[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.event.content)).toEqual(['1', '123']);
  });

  it('never posts older content after newer (monotonic per chunkId)', async () => {
    const { sent, coalescer } = harness({ autoResolve: true, latencyMs: 37 });
    let content = '';
    for (let i = 0; i < 100; i++) {
      content += 'x';
      void coalescer.submit(chunk('a', content));
      await vi.advanceTimersByTimeAsync(7);
    }
    const done = coalescer.submit(chunk('a', content, true));
    await vi.advanceTimersByTimeAsync(500);
    await done;
    const lengths = sent.map((s) => s.event.content.length);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
    expect(sent[sent.length - 1].event).toEqual(chunk('a', content, true));
  });

  it('two interleaved chunkIds do not block each other', async () => {
    const { sent, coalescer } = harness({ autoResolve: false });
    void coalescer.submit(chunk('a', 'a1'));
    void coalescer.submit(chunk('a', 'a2'));
    // `a` has a request stuck in flight; a new message's chunk still goes at once.
    void coalescer.submit(chunk('b', 'b1'));
    expect(sent.map((s) => s.event.content)).toEqual(['a1', 'b1']);
    sent[1].resolve();
    void coalescer.submit(chunk('b', 'b2', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.event.content)).toEqual(['a1', 'b1', 'b2']);
    sent[0].resolve();
    await vi.advanceTimersByTimeAsync(STREAMING_CHUNK_MIN_INTERVAL_MS);
    expect(sent.map((s) => s.event.content)).toEqual(['a1', 'b1', 'b2', 'a2']);
  });

  it('flush() sends pending latest content at once and waits for it', async () => {
    const { sent, coalescer } = harness({ autoResolve: true, latencyMs: 20 });
    void coalescer.submit(chunk('a', 'a1'));
    void coalescer.submit(chunk('a', 'a1 a2'));
    void coalescer.submit(chunk('b', 'b1'));
    void coalescer.submit(chunk('b', 'b1 b2'));
    let flushed = false;
    const flush = coalescer.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(45); // two 20 ms round-trips, well under the 100 ms spacing
    await flush;
    expect(flushed).toBe(true);
    expect(sent.map((s) => s.event.content)).toEqual(['a1', 'b1', 'a1 a2', 'b1 b2']);
  });

  it('a send failure does not wedge the chunk', async () => {
    const send = vi
      .fn<(event: StreamingChunkEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const coalescer = new StreamingChunkCoalescer({ send });
    void coalescer.submit(chunk('a', '1'));
    await coalescer.submit(chunk('a', '12', true));
    expect(send.mock.calls.map((c) => c[0].content)).toEqual(['1', '12']);
  });

  it.each([60, 300])(
    'measured: a 20 updates/s stream for 10 s with %i ms request latency',
    async (latencyMs) => {
      const { sent, coalescer } = harness({ autoResolve: true, latencyMs });
      const updates = 200;
      let content = '';
      for (let i = 0; i < updates; i++) {
        content += `token${i} `;
        void coalescer.submit(chunk('a', content));
        await vi.advanceTimersByTimeAsync(50);
      }
      const done = coalescer.submit(chunk('a', content, true));
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      const posts = sent.length;
      // Before: one POST per update + the final (201). Now ≤ one per 100 ms,
      // fewer when the server is slow (one in flight at a time).
      expect(posts).toBeLessThanOrEqual(updates / 2 + 2);
      expect(sent[posts - 1].event).toEqual(chunk('a', content, true));
      console.warn(
        `[coalescer] 20/s, ${latencyMs} ms latency: ${updates + 1} submits → ${posts} posts`,
      );
    },
  );
});
