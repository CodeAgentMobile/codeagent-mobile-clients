/**
 * The turn's OWN delta, against a real git repo.
 *
 * Owner's session, 2026-11-24: the post-turn card read "47 files +9470" on
 * every turn — the working tree against HEAD, diffed against a baseline taken
 * once at session start, `package-lock.json`'s thousands of lines included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TurnFileAggregator } from '../../src/services/turn-files/turn-file-aggregator';
import { RepoDirtyTracker } from '../../src/services/turn-files/repo-dirty-tracker';
import { _transport } from '../../src/services/file-watcher/transport';
import { isLockfilePath } from '../../src/services/turn-files/turn-delta';

let repo: string;
let outboxDir: string;

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n';
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-td-'));
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-td-outbox-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write('README.md', 'hi\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  vi.spyOn(_transport, 'post').mockResolvedValue({ statusCode: 500, body: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

function outbox(): Array<{ turn?: { files: number; added: number; removed: number } }> {
  const file = path.join(outboxDir, 's1.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function mk(tracker: RepoDirtyTracker): TurnFileAggregator {
  return new TurnFileAggregator({
    workingDir: repo,
    sessionId: 's1',
    pluginId: 'p1',
    pluginAuthToken: 't',
    apiBaseUrl: 'https://api.example.test',
    outboxDir,
    dirtyTracker: tracker,
    outboxAutoSchedule: false,
  });
}

describe("the turn's own delta", () => {
  it("counts each turn by itself, never the session's running total", async () => {
    // Dirt from before the session never belongs to a turn.
    write('pre-existing.txt', lines(50, 'p'));
    const tracker = new RepoDirtyTracker();
    const agg = mk(tracker);
    await agg.flushTurn(); // session-start baseline

    // Turn 1: a new file.
    write('src/a.ts', lines(3, 'a'));
    tracker.markDirty(repo);
    await agg.flushTurn();
    expect(outbox().at(-1)?.turn).toEqual({ files: 1, added: 3, removed: 0 });

    // Turn 2: edit a.ts (one line changed, one added) + an npm install.
    write('src/a.ts', 'a0\nCHANGED\na2\na3\n');
    write('package-lock.json', lines(9000, 'x'));
    tracker.markDirty(repo);
    await agg.flushTurn();
    // The lockfile counts as a file; its 9000 lines don't.
    expect(outbox().at(-1)?.turn).toEqual({ files: 2, added: 2, removed: 1 });
    agg.stop();
  });

  it('a mid-turn flush reports progress without moving the turn start', async () => {
    const tracker = new RepoDirtyTracker();
    const agg = mk(tracker);
    await agg.flushTurn();

    write('b.ts', lines(2, 'b'));
    tracker.markDirty(repo);
    await agg.flushTurn({ turnBoundary: false });
    expect(outbox().at(-1)?.turn).toEqual({ files: 1, added: 2, removed: 0 });

    write('c.ts', lines(4, 'c'));
    tracker.markDirty(repo);
    await agg.flushTurn();
    expect(outbox().at(-1)?.turn).toEqual({ files: 2, added: 6, removed: 0 });

    // The next turn starts where that one ended.
    write('d.ts', lines(1, 'd'));
    tracker.markDirty(repo);
    await agg.flushTurn();
    expect(outbox().at(-1)?.turn).toEqual({ files: 1, added: 1, removed: 0 });
    agg.stop();
  });

  it("leaves our runtime dirs out and never touches the user's index", async () => {
    const tracker = new RepoDirtyTracker();
    const agg = mk(tracker);
    await agg.flushTurn();
    const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));

    write('.wrangler/state/db.sqlite', lines(100));
    write('src/x.ts', lines(5));
    tracker.markDirty(repo);
    await agg.flushTurn();
    expect(outbox().at(-1)?.turn).toEqual({ files: 1, added: 5, removed: 0 });
    expect(fs.readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: repo }).toString()).toContain('?? src/x.ts');
    agg.stop();
  });
});

describe('isLockfilePath', () => {
  it.each(['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum'])('%s', (p) =>
    expect(isLockfilePath(p)).toBe(true),
  );
  it.each(['package.json', 'src/lock.ts'])('not %s', (p) => expect(isLockfilePath(p)).toBe(false));
});
