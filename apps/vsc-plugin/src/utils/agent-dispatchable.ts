/**
 * Agent ids `CopilotLmStrategy` dispatches through `vscode.lm`. Includes:
 *   - the canonical `__vscode_lm__:<vendor>` prefix
 *   - the marketplace extension ids the ExtensionOnlyDetector registers
 *     (github.copilot, github.copilot-chat)
 *   - the normalised short id the mobile picker sends after
 *     `normalizeRuntimeAgentId` collapses `github.copilot-chat` → `copilot`
 */
const COPILOT_LM_AGENT_IDS = new Set(['github.copilot-chat', 'github.copilot', 'copilot']);

export function isCopilotLmAgentId(raw: string | undefined): boolean {
  const id = raw?.toLowerCase();
  if (!id) return false;
  return id.startsWith('__vscode_lm__:') || COPILOT_LM_AGENT_IDS.has(id);
}

/**
 * Whether this extension can really hand a prompt to the agent — reported to
 * the apps as `dispatchable` so they only offer what the session can run.
 *
 * Only Copilot (`vscode.lm`) is. Every other detected extension (Windsurf,
 * Kilo Code, Continue …) falls to `ObserverBridgeStrategy`, which can only
 * copy the prompt to this computer's clipboard; terminal agents are refused by
 * `RemoteCommandRouter` because codeam-cli runs them. The apps used to offer
 * all of them and the prompts went nowhere (codeagent-vzbd).
 */
export function isDispatchableAgent(agent: { id: string; isTerminalAgent?: boolean }): boolean {
  return isCopilotLmAgentId(agent.id) && !agent.isTerminalAgent;
}
