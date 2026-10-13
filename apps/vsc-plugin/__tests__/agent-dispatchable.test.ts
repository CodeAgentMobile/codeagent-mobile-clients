import { describe, expect, it } from 'vitest';
import { isCopilotLmAgentId, isDispatchableAgent } from '../src/utils/agent-dispatchable';

/**
 * The extension reports `dispatchable` per agent so the apps offer only what
 * it can deliver a prompt to (codeagent-vzbd: Windsurf / Kilo Code / Continue
 * prompts sent from the phone landed on the computer's clipboard).
 */
describe('isDispatchableAgent', () => {
  it('Copilot through vscode.lm is dispatchable, under every id it arrives with', () => {
    for (const id of ['__vscode_lm__:copilot', 'github.copilot-chat', 'github.copilot', 'copilot', 'GitHub.Copilot-Chat']) {
      expect(isCopilotLmAgentId(id)).toBe(true);
      expect(isDispatchableAgent({ id })).toBe(true);
    }
  });

  it('extensions with no prompt API are not', () => {
    for (const id of ['codeium.windsurf', 'kilocode.kilo-code', 'Continue.continue', 'saoudrizwan.claude-dev']) {
      expect(isDispatchableAgent({ id, isTerminalAgent: false })).toBe(false);
    }
  });

  it('terminal agents are not — codeam-cli runs them', () => {
    expect(isDispatchableAgent({ id: 'claude', isTerminalAgent: true })).toBe(false);
    expect(isDispatchableAgent({ id: '__terminal__:codex' })).toBe(false);
  });
});
