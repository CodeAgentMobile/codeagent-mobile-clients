import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * "A turn is running in THIS process" — a file the host-agent can see.
 *
 * ⚠️ WHY (owner rule, 2026-09-26: a fix must heal EXISTING sessions the next
 * time they are used). A host-agent only restarts onto a self-installed update
 * when its session children are idle, and it had no way to tell an idle session
 * from a working one — a paired box ALWAYS has a child, so every update waited
 * out the 24 h ceiling. The owner's 24/7 host ran 2.75.21 all day with 2.75.32
 * on disk, and every CLI fix shipped that day missed it. With this marker the
 * host-agent restarts at its next hourly tick unless a turn is actually running.
 *
 * Counted, so overlapping turns (a squad hop inside a turn) keep it until the
 * last one ends. Best-effort: a filesystem error never affects the turn.
 */
let depth = 0;

function codeamHome(): string {
  return path.join(os.homedir(), '.codeam');
}

export function turnsDir(home: string = codeamHome()): string {
  return path.join(home, 'turns');
}

export function turnMarkerPath(pid: number = process.pid, home: string = codeamHome()): string {
  return path.join(turnsDir(home), String(pid));
}

/**
 * Calls `onChange` whenever a turn marker appears or goes away (any process of this
 * user). The host-agent uses it to restart onto an installed update the moment the
 * last running turn ends, instead of at its next hourly tick. Returns the closer;
 * a filesystem that can't be watched yields a no-op (the hourly tick still covers it).
 */
export function watchTurnMarkers(onChange: () => void, home?: string): () => void {
  try {
    const dir = turnsDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, () => onChange());
    watcher.on('error', () => undefined);
    watcher.unref?.();
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}

function mark(): void {
  try {
    const file = turnMarkerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
  } catch {
    /* best-effort */
  }
}

function clear(): void {
  try {
    fs.rmSync(turnMarkerPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Run `fn` as a turn: the marker exists from start until the LAST overlapping turn ends. */
export async function withTurnMarker<T>(fn: () => Promise<T>): Promise<T> {
  if (depth++ === 0) mark();
  try {
    return await fn();
  } finally {
    if (--depth === 0) clear();
  }
}

/** Is the process `pid` in the middle of a turn? */
export function isProcessMidTurn(pid: number | undefined, home?: string): boolean {
  if (!pid) return false;
  try {
    return fs.existsSync(turnMarkerPath(pid, home));
  } catch {
    return false;
  }
}

/** Test seam. */
export function __resetTurnMarkerDepth(): void {
  depth = 0;
}
