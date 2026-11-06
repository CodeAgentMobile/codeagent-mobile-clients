/**
 * Best-effort on-demand installer for Antigravity CLI (`agy`) — LOCAL pair
 * parity with the codespace bootstrap (`INSTALL_SNIPPETS.antigravity`) and the
 * baked box image (`/usr/local/bin/agy`).
 *
 * When a user runs `codeam pair` with Antigravity selected but `agy` isn't
 * installed, the ACP adapter would otherwise spawn `agy acp` and fail with a raw
 * `ENOENT`. Instead we run Google's official no-sudo installer
 * (`curl -fsSL https://antigravity.google/cli/install.sh | bash`, which drops the
 * binary in `~/.local/bin`), fold that dir into PATH, and re-probe — mirroring
 * opencode's `ensureOpencodeInstalled`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { log } from '../../services/logger';
import { augmentUserLocalBinPaths } from '../acp/agent-binary';

export const ANTIGRAVITY_INSTALL_URL = 'https://antigravity.google/cli/install.sh';

/** True only when a runnable `agy` is on PATH — a `--version` that exits 0. */
function agyRuns(): boolean {
  const r = spawnSync('agy', ['--version'], { stdio: 'ignore', timeout: 15_000 });
  return !r.error && r.status === 0;
}

async function runInstaller(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn('sh', ['-c', `curl -fsSL ${ANTIGRAVITY_INSTALL_URL} | bash`], {
      stdio: 'inherit',
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Ensure a runnable `agy` is on PATH, installing it on demand. Returns true when
 * `agy` is (now) runnable, false when installation isn't possible/failed (the
 * caller then surfaces the normal not-found error). Never throws.
 */
export async function ensureAntigravityInstalled(): Promise<boolean> {
  augmentUserLocalBinPaths(); // maybe already in ~/.local/bin, just off PATH
  if (agyRuns()) return true;

  if (process.platform === 'win32') {
    console.error(
      '\n  ✗ Antigravity CLI is not installed.\n' +
        '    Install it from https://antigravity.google/cli (Windows installer),\n' +
        '    then re-run `codeam pair`.\n',
    );
    return false;
  }

  console.log('\n  Antigravity CLI not found — installing via the official script…\n');
  const ok = await runInstaller();
  augmentUserLocalBinPaths();
  if (!ok) {
    log.warn('antigravity', 'installer failed — agy will be reported as not installed');
    return false;
  }
  return agyRuns();
}
