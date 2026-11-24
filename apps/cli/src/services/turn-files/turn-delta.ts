import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isIgnoredFilePath } from '../file-watcher/ignored-paths';
import { parseNumstat, runGit } from './git-changeset';
import { makeReviewIgnore } from './review-ignore';

/**
 * What ONE TURN changed — not the working tree against HEAD.
 *
 * ⚠️ WHY (owner's session, 2026-11-24): the post-turn card read "47 files
 * +9470" on every turn. The batch is the tree against HEAD (right for the
 * review queue), diffed against a baseline taken ONCE at session start, so the
 * card showed the session's running total, `package-lock.json`'s thousands of
 * lines included. The card asks a different question: what did the agent just
 * do?
 *
 * How: a git TREE of the working tree is written at each turn boundary (a
 * throwaway index seeded from the real one, `git add -A` of the changed paths,
 * `git write-tree` — the same objects `git stash` writes, nothing touches the
 * user's index or refs), and the turn's delta is `git diff --numstat` between
 * the tree at the previous boundary and now. Exact, and cheap: git only
 * re-hashes the changed paths.
 */

export interface TurnDelta {
  files: number;
  added: number;
  removed: number;
}

/**
 * Lockfiles: the file counts as changed, its LINES don't — an `npm install`
 * rewrites thousands of them and drowns what the agent wrote (GitHub's
 * `linguist-generated`). Mirror of `isLockfilePath` in codeagent-mobile
 * `packages/session-core/src/turnResult.ts`.
 */
const LOCKFILE_RE =
  /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|go\.sum|Podfile\.lock|pubspec\.lock|mix\.lock|flake\.lock|gradle\.lockfile|packages\.lock\.json)$/i;

export function isLockfilePath(filePath: string): boolean {
  return LOCKFILE_RE.test(filePath);
}

const TREE_SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * A tree object of `repoRoot`'s working tree: the index as it is, plus the
 * working-tree state of `changedPaths` (the changeset's paths, already
 * filtered). Null on any git failure — the caller then omits the delta.
 */
export async function snapshotWorkingTree(
  repoRoot: string,
  changedPaths: readonly string[],
): Promise<string | null> {
  const indexPathRaw = await runGit(repoRoot, ['rev-parse', '--git-path', 'index']);
  if (indexPathRaw === null) return null;
  const realIndex = path.resolve(repoRoot, indexPathRaw.trim());
  const tmp = path.join(os.tmpdir(), `codeam-turn-${randomUUID()}`);
  const tmpIndex = `${tmp}.index`;
  const tmpSpec = `${tmp}.paths`;
  try {
    // A repo with nothing staged yet has no index: start from an empty one.
    await fs.copyFile(realIndex, tmpIndex).catch(() => undefined);
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (changedPaths.length > 0) {
      await fs.writeFile(tmpSpec, changedPaths.join('\0'));
      const added = await runGit(
        repoRoot,
        ['add', '-A', `--pathspec-from-file=${tmpSpec}`, '--pathspec-file-nul'],
        env,
      );
      if (added === null) return null;
    }
    const tree = (await runGit(repoRoot, ['write-tree'], env))?.trim() ?? '';
    return TREE_SHA_RE.test(tree) ? tree : null;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
    await fs.rm(tmpSpec, { force: true }).catch(() => undefined);
  }
}

/**
 * The delta between two snapshots, filtered like the changeset (vendor/build
 * dirs, our runtime dirs, the curated review-ignore list) and with lockfile
 * lines left out. Null on a git failure.
 */
export async function diffSnapshots(
  repoRoot: string,
  from: string,
  to: string,
): Promise<TurnDelta | null> {
  if (from === to) return { files: 0, added: 0, removed: 0 };
  const raw = await runGit(repoRoot, ['diff', '--numstat', '-z', '--no-renames', from, to]);
  if (raw === null) return null;
  const reviewIgnore = makeReviewIgnore(repoRoot);
  const delta: TurnDelta = { files: 0, added: 0, removed: 0 };
  for (const [filePath, stat] of parseNumstat(raw)) {
    if (isIgnoredFilePath(filePath) || reviewIgnore(filePath)) continue;
    delta.files += 1;
    if (isLockfilePath(filePath)) continue;
    delta.added += stat.added;
    delta.removed += stat.removed;
  }
  return delta;
}
