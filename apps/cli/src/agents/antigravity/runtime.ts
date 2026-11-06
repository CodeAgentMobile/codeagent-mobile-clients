/**
 * AntigravityRuntimeStrategy — RuntimeStrategy for Google's Antigravity CLI
 * (`agy`), the consumer-account successor to Gemini CLI.
 *
 * Antigravity is driven EXCLUSIVELY via the ACP runtime (`agy acp`, official
 * since agy 1.5.0) — see `apps/cli/src/agents/acp/adapters.ts`.
 * `requiresAcp('antigravity')` always routes it through ACP; the PTY-spawn path
 * is never reached. This strategy exists so the non-spawn code paths that touch
 * every registered agent still resolve:
 *
 *   - `codeam link antigravity` → `credentialLocator()` / `loginLauncher()`.
 *   - AI Insights / Summary + Preview detection → `generateOneShot()`.
 *   - The agent-contract suite iterates every runtime builder.
 *
 * Baton (Take Control) is not wired for v1 (`resolveHistoryFile` omitted →
 * `runtimeSupportsBaton` is false), although agy's ACP does support
 * `session/load`; wiring it needs agy's transcript layout first.
 */

import {
  getAgent,
  type AgentId,
  type AgentMetadata,
  type AgentModel,
  type NormalizedMessage,
  type SelectPrompt,
} from '@codeam/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import { spawnAndCapture } from '../../services/spawn-and-capture';
import { createOsStrategy } from '../../os';
import type { OsStrategy } from '../../os';
import type {
  AgentCredentialLocator,
  AgentLoginLauncher,
  ChangeModelInstruction,
  RuntimeStrategy,
} from '../strategy';
import {
  antigravityCredentialsPaths,
  extractLocalAntigravityToken,
  validateLocalAntigravityToken,
} from './local-token';
import { ANTIGRAVITY_INSTALL_URL, ensureAntigravityInstalled } from './installer';

/** One-shot budget when the caller passes none (preview detection is the slow one). */
const DEFAULT_ONE_SHOT_TIMEOUT_MS = 120_000;
/** Kill grace past agy's own `--print-timeout`, so agy normally exits on its own. */
const ONE_SHOT_KILL_GRACE_MS = 5_000;

export class AntigravityRuntimeStrategy implements RuntimeStrategy {
  readonly id: AgentId = 'antigravity';
  readonly meta: AgentMetadata = getAgent('antigravity');
  readonly mode = 'interactive' as const;
  readonly os: OsStrategy;

  constructor(os: OsStrategy) {
    this.os = os;
  }

  async prepareLaunch(): Promise<{
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    sessionId?: string;
  }> {
    const binary = this.os.findInPath('agy');
    if (!binary) {
      throw new Error(
        'Antigravity CLI (agy) is not on PATH. Install it with:\n' +
          `    curl -fsSL ${ANTIGRAVITY_INSTALL_URL} | bash\n` +
          '    Then run `codeam pair` again.',
      );
    }
    // Production never spawns agy over a PTY (ACP path); this satisfies the
    // contract so `createInteractiveAgentStrategy` resolves cleanly.
    const launch = this.os.buildLaunch(binary, []);
    return { cmd: launch.cmd, args: launch.args };
  }

  resumeLaunchArgs(sessionId: string, _opts?: { auto?: boolean }): string[] {
    return ['--conversation', sessionId];
  }

  resolveHistoryDir(_cwd: string): string | null {
    return null;
  }

  parseHistoryFile(_filePath: string): NormalizedMessage[] {
    return [];
  }

  getCurrentUsage(
    _historyDir: string,
  ): { used: number; total: number; percent: number; model?: string } | null {
    return null;
  }

  async fetchWeeklyUsage(): Promise<{ percent: number; resetAt?: string } | null> {
    return null;
  }

  async listModels(): Promise<AgentModel[]> {
    // agy picks its model from the signed-in account / settings.json; the ACP
    // session reports the live list. A sentinel keeps the ≥1-model contract
    // without claiming we route the model (Gemini-class 1M context window).
    return [{ id: 'default', label: 'Account default', contextWindow: 1_000_000 }];
  }

  changeModelInstruction(modelId: string): ChangeModelInstruction {
    return { type: 'pty', ptyInput: `/model ${modelId}\r` };
  }

  summarizeInstruction(_mode: 'normal' | 'auto'): { ptyInput: string } {
    return { ptyInput: '/compact\r' };
  }

  filterTuiOutput(lines: string[]): string[] {
    return lines;
  }

  detectInteractivePrompt(_lines: string[]): SelectPrompt | null {
    return null;
  }

  /**
   * Headless single prompt — powers AI summaries/insights AND Preview
   * detection. `agy -p "<prompt>"` prints the reply to stdout and exits. agy
   * has no workspace-trust gate (no flag needed), but with no credentials it
   * waits for a pasted sign-in code, and `--print-timeout` does NOT bound that
   * wait (verified on agy 1.5.2: `--print-timeout 5s` signed out hung until
   * killed). So `--print-timeout` bounds the turn and OUR kill timer
   * (`spawnAndCapture`'s timeout) bounds the sign-in wait. `null` on
   * failure/timeout/empty output so callers skip silently.
   */
  async generateOneShot(
    prompt: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      onStderr?: (chunk: string) => void;
      onFailedOutput?: (stdout: string) => void;
    },
  ): Promise<string | null> {
    const binary = this.os.findInPath('agy');
    if (!binary) return null;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_ONE_SHOT_TIMEOUT_MS;
    const printTimeoutSec = Math.max(1, Math.floor(timeoutMs / 1000));
    const launch = this.os.buildLaunch(binary, [
      '-p',
      prompt,
      '--print-timeout',
      `${printTimeoutSec}s`,
    ]);
    return spawnAndCapture(launch.cmd, launch.args, {
      onStderr: opts?.onStderr,
      onFailedOutput: opts?.onFailedOutput,
      cwd: opts?.cwd,
      timeoutMs: timeoutMs + ONE_SHOT_KILL_GRACE_MS,
    });
  }

  credentialLocator(): AgentCredentialLocator {
    return {
      publicId: 'antigravity',
      vendor: 'Google',
      hint: '~/.gemini/antigravity-cli/antigravity-oauth-token (sign in with `agy`) or GEMINI_API_KEY',
      watchPaths: antigravityCredentialsPaths,
      extract: extractLocalAntigravityToken,
      validate: validateLocalAntigravityToken,
    };
  }

  loginLauncher(): AgentLoginLauncher {
    return {
      async ensureInstalled(): Promise<boolean> {
        if (createOsStrategy().findInPath('agy') !== null) return true;
        return ensureAntigravityInstalled();
      },
      launch(): ChildProcess {
        // A bare `agy` opens the sign-in flow when signed out; inherited stdio
        // lets the user finish it, after which the token file is captured.
        return spawn('agy', [], { stdio: 'inherit' });
      },
    };
  }
}
