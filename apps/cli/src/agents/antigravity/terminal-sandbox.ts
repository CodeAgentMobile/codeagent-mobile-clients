/**
 * Antigravity's terminal sandbox and the hosts that cannot run it.
 *
 * agy's `auto` mode runs every shell command inside its own terminal sandbox:
 * on Linux it re-executes itself in a new user namespace. A container whose
 * seccomp profile blocks unprivileged user namespaces (GitHub Codespaces, our
 * CodeAgent Box with `--cap-drop ALL`) refuses that clone, and every command
 * fails with
 *
 *   Command failed to run: fork/exec /usr/local/bin/agy: operation not permitted
 *
 * (`git status`, `ls`, `curl` — owner's codespace, 2026-11-24; reproduced with
 * `agy acp` + `session/set_mode auto` in a temp clone). The model may retry
 * with `BypassSandbox`, or may give up and tell the user to run the command.
 * agy's own `--mode auto` print mode refuses the mode on this host, but
 * `agy acp` still advertises `auto` and accepts it. `enableTerminalSandbox:
 * false` in settings.json does not change what `auto` does.
 *
 * In `default` mode agy asks before each command and runs it OUTSIDE the
 * sandbox once allowed (verified on the same host). So on a host without the
 * sandbox the client keeps `auto` on the picker, sets agy to `default`, and the
 * CLI's own auto-approve answers the prompts. Every command then goes through
 * our permission gate (internal-path guard, guardrails), which agy's own
 * `auto` skips. The container is the isolation.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ModeSubstitute } from '../acp/modes';

let cached: boolean | undefined;

function readKnob(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * True when agy's terminal sandbox can run here. macOS and Windows use their
 * own OS sandboxes, which agy handles itself. On Linux we attempt the same
 * thing agy does, an unprivileged user namespace, with `unshare`: our process
 * runs under the same seccomp profile as the agy it spawns. Cached for the
 * process lifetime.
 */
export function agyTerminalSandboxAvailable(): boolean {
  if (cached !== undefined) return cached;
  cached = probe();
  return cached;
}

function probe(): boolean {
  if (process.platform !== 'linux') return true;
  const r = spawnSync('unshare', ['--user', '--map-root-user', 'true'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (!r.error) return r.status === 0;
  // No `unshare` binary: fall back to the kernel switches that disable them.
  return (
    readKnob('/proc/sys/user/max_user_namespaces') !== '0' &&
    readKnob('/proc/sys/kernel/unprivileged_userns_clone') !== '0'
  );
}

/** Test seam: forget the cached probe result. */
export function resetAgyTerminalSandboxProbe(): void {
  cached = undefined;
}

/**
 * The agy modes this host cannot run natively. Empty when the sandbox works.
 */
export function antigravityModeSubstitutes(
  sandboxAvailable: boolean = agyTerminalSandboxAvailable(),
): Readonly<Record<string, ModeSubstitute>> | undefined {
  if (sandboxAvailable) return undefined;
  return {
    auto: {
      agentModeId: 'default',
      autoApprove: true,
      description:
        'Approve edits and commands without asking. CodeAgent guardrails still apply.',
    },
  };
}
