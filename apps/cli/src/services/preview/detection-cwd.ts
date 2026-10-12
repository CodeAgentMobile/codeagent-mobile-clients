import fs from 'node:fs';
import path from 'node:path';

type DetectionCwd = { ok: true; dir: string } | { ok: false; message: string };

/**
 * The directory a detection's dev server runs in: `detection.cwd` resolved
 * against the workspace root, or the root itself when it is absent / `'.'`.
 *
 * codeagent-hz3h (2026-10-12): a FastAPI app the agent built in `teleshop/`,
 * with its venv at `teleshop/.venv`. The detection said `.venv/bin/python`,
 * the spawn ran at the workspace root, and every start died `spawn
 * .venv/bin/python ENOENT` — shown to the user as "exited (code -2) … may need
 * a database". There was no way to say "run it in teleshop/".
 *
 * Refuses a folder outside the workspace (an agent-written or committed
 * `.codeam/preview.json` must not point the spawn at `/etc` or `../other`) and
 * one that doesn't exist (Node reports a missing cwd as the same ENOENT as a
 * missing binary, which would blame the wrong thing).
 */
export function resolveDetectionCwd(root: string, cwd: string | undefined): DetectionCwd {
  const rel = typeof cwd === 'string' ? cwd.trim() : '';
  if (!rel || rel === '.') return { ok: true, dir: root };
  const dir = path.resolve(root, rel);
  const inside = path.relative(root, dir);
  if (path.isAbsolute(rel) || inside.startsWith('..') || path.isAbsolute(inside)) {
    return {
      ok: false,
      message: `The preview's folder "${rel}" is outside this project. Use a folder inside it (e.g. "app"), or "." for the root.`,
    };
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      ok: false,
      message: `The preview's folder "${rel}" doesn't exist in this project. Retry detection, or fix "cwd" in .codeam/preview.json.`,
    };
  }
  return { ok: true, dir };
}
