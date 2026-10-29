import type { StreamingChunkEvent } from '@codeam/shared';

/**
 * Minimum spacing between two POSTs of the SAME chunkId. Every snapshot is
 * CUMULATIVE, so a newer one fully replaces the older on mobile — sending one
 * per ACP delta (10–30/s for a single chunk on 2026-10-29) only loads the API.
 */
export const STREAMING_CHUNK_MIN_INTERVAL_MS = 100;

/** How many finalised chunkIds are remembered to drop late non-final snapshots. */
const FINALIZED_MEMORY = 512;

interface Pending {
  event: StreamingChunkEvent;
  waiters: Array<() => void>;
}

interface ChunkState {
  pending: Pending | null;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastSentAt: number;
}

export interface StreamingChunkCoalescerOptions {
  /** Performs one POST. Must not throw; retries/logging live inside it. */
  send: (event: StreamingChunkEvent) => Promise<void>;
  /** Spacing for a given snapshot (lets big snapshots use a wider window). */
  intervalFor?: (event: StreamingChunkEvent) => number;
}

/**
 * Per-chunkId latest-wins coalescing for the streaming-chunk feed:
 *  - the first snapshot of a chunkId goes out immediately;
 *  - at most ONE request in flight per chunkId, posts spaced by the interval;
 *    snapshots arriving meanwhile collapse into the latest one;
 *  - an `isFinal` snapshot supersedes anything pending, skips the spacing wait
 *    and is sent right after the in-flight request, so it is always the last
 *    POST of its chunkId; later non-final snapshots of that id are dropped;
 *  - chunkIds never wait on each other.
 * The promise from {@link submit} settles once the submitted content (or a
 * newer snapshot that superseded it) has been sent.
 */
export class StreamingChunkCoalescer {
  private readonly chunks = new Map<string, ChunkState>();
  private readonly finalized = new Set<string>();

  constructor(private readonly opts: StreamingChunkCoalescerOptions) {}

  submit(event: StreamingChunkEvent): Promise<void> {
    const { chunkId } = event;
    if (this.finalized.has(chunkId)) return Promise.resolve();
    const state = this.chunks.get(chunkId) ?? this.open(chunkId);
    const settled = new Promise<void>((resolve) => {
      const waiters = state.pending ? state.pending.waiters : [];
      waiters.push(resolve);
      state.pending = { event, waiters };
    });
    if (event.isFinal) {
      this.markFinalized(chunkId);
      this.drain(chunkId, state);
    } else {
      this.schedule(chunkId, state);
    }
    return settled;
  }

  /** Send every pending snapshot now (ignoring the spacing) and wait for all
   *  requests to settle. Used on shutdown so the latest content is not lost. */
  async flush(): Promise<void> {
    const work = Array.from(this.chunks.entries()).map(async ([chunkId, state]) => {
      while (state.inFlight || state.pending) {
        if (!state.inFlight) this.drain(chunkId, state);
        await state.inFlight;
      }
    });
    await Promise.all(work);
  }

  private open(chunkId: string): ChunkState {
    const state: ChunkState = { pending: null, inFlight: null, timer: null, lastSentAt: 0 };
    this.chunks.set(chunkId, state);
    return state;
  }

  private schedule(chunkId: string, state: ChunkState): void {
    if (state.inFlight || state.timer || !state.pending) return;
    const wait = this.intervalFor(state.pending.event) - (Date.now() - state.lastSentAt);
    if (wait <= 0) {
      this.drain(chunkId, state);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      this.drain(chunkId, state);
    }, wait);
  }

  /** Send the pending snapshot now, unless a request is still in flight
   *  (its completion re-enters here or {@link schedule}). */
  private drain(chunkId: string, state: ChunkState): void {
    if (state.inFlight || !state.pending) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const { event, waiters } = state.pending;
    state.pending = null;
    state.lastSentAt = Date.now();
    state.inFlight = this.opts
      .send(event)
      .catch(() => undefined)
      .then(() => {
        state.inFlight = null;
        for (const resolve of waiters) resolve();
        if (!state.pending) {
          if (event.isFinal) this.chunks.delete(chunkId);
          return;
        }
        if (state.pending.event.isFinal) this.drain(chunkId, state);
        else this.schedule(chunkId, state);
      });
  }

  private intervalFor(event: StreamingChunkEvent): number {
    return this.opts.intervalFor?.(event) ?? STREAMING_CHUNK_MIN_INTERVAL_MS;
  }

  private markFinalized(chunkId: string): void {
    this.finalized.add(chunkId);
    if (this.finalized.size > FINALIZED_MEMORY) {
      const oldest = this.finalized.values().next().value;
      if (oldest !== undefined) this.finalized.delete(oldest);
    }
  }
}
