/**
 * One user turn at a time, from the moment it opens on the phone until its
 * last frame is published.
 *
 * `AcpClient.prompt` already serializes the `session/prompt` RPCs, but a
 * `start_task` handler does turn work BEFORE and AFTER that call: it opens the
 * turn on the app (`streaming.beginTurn()` publishes `clear` + `new_turn`),
 * reports `started`, and after the reply it reads and closes the streamed text.
 * A message sent while a turn was running used to do its opening work at once
 * — wiping the live turn's output on the phone and claiming its own turn had
 * started 30 minutes before it did — and, after a failed turn, the next queued
 * prompt reached the adapter before the failed turn's cleanup `session/cancel`,
 * so that cancel landed on the innocent next turn (codeagent-u7mm, whait930
 * 2026-10-13: two queued messages failed, one as "empty reply").
 *
 * A failed or throwing turn never wedges the queue.
 */
export class TurnQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;

  /** True while a turn runs or waits to run. */
  get busy(): boolean {
    return this.active > 0;
  }

  run<T>(turn: () => Promise<T>): Promise<T> {
    this.active += 1;
    const result = this.tail.then(turn).finally(() => {
      this.active -= 1;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
