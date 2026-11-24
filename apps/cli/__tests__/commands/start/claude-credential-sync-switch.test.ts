/**
 * Claude credential-sync must follow the RUNTIME agent, not only the agent the
 * session started on (owner, 2026-11-24). A session that starts on another
 * agent and SWITCHES to Claude runs Claude on the vaulted OAuth login; Claude
 * rotates its single-use refresh_token on the box, and without the watcher the
 * vault kept the spent token, so the next switch/deploy refreshed it into
 * `invalid_grant` and the user was told to re-link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeSessionBase = {
  id: 'sess-1',
  pluginId: 'plugin-1',
  userName: 'Test User',
  userEmail: 'test@example.com',
  plan: 'PRO',
  pairedAt: Date.now(),
  pluginAuthToken: 'tok-abc123',
  pollSecret: 'poll-secret',
};

vi.mock('../../../src/config', () => ({
  addSession: vi.fn(),
  getActiveSession: vi.fn(),
  getActiveSessionForAgent: vi.fn(),
  ensurePluginId: vi.fn(() => 'plugin-1'),
  loadCliConfig: vi.fn(() => ({ sessions: [] })),
}));

vi.mock('../../../src/commands/pair-auto', () => ({
  acquireDaemonLock: vi.fn(() => true),
}));

vi.mock('../../../src/ui/banner', () => ({
  showIntro: vi.fn(),
  showInfo: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../../src/services/pairing.service', () => ({
  fetchCurrentPluginAuthToken: vi.fn(async () => undefined),
  postPreviewEvent: vi.fn(),
}));

vi.mock('../../../src/services/telemetry.service', () => ({
  capture: vi.fn(),
  identifyUser: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../../../src/agents/claude/onboarding', () => ({
  ensureClaudeOnboarded: vi.fn(),
}));

vi.mock('../../../src/beads/wiring', () => ({
  provisionBeadsForStart: vi.fn(async () => null),
}));

// Best-effort backend calls on the start path: unmocked, they reached the
// production API on every run (the global guard in fixtures/prod-api-guard.ts).
vi.mock('../../../src/integrations/refresh-manifest', () => ({
  refreshIntegrationsManifest: vi.fn(async () => ({ status: 'skipped', reason: 'test' })),
}));
vi.mock('../../../src/agents/claude/credential-sync', () => ({
  startClaudeCredentialSync: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
}));
vi.mock('../../../src/integrations/provision', () => ({
  buildMcpServersForStart: vi.fn(() => []),
}));

vi.mock('../../../src/baton/gate', () => ({
  isLocalSession: vi.fn(() => false),
  runtimeSupportsBaton: vi.fn(() => false),
}));

vi.mock('../../../src/baton/wire-baton', () => ({
  runBatonSession: vi.fn(),
}));

vi.mock('../../../src/agents/registry', () => ({
  createRuntimeStrategy: vi.fn(() => {
    throw new Error('SENTINEL_PTY_REACHED');
  }),
}));

vi.mock('../../../src/agents/acp/runner', () => ({
  runAcpSession: vi.fn(async () => undefined),
  surfaceStartupFailure: vi.fn(async () => undefined),
}));

// Every ACP agent resolves to a stub adapter so `start()` reaches runAcpSession.
vi.mock('../../../src/agents/acp/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agents/acp/adapters')>();
  return {
    ...actual,
    getAcpAdapter: vi.fn(() => ({
      command: 'stub-acp',
      args: [],
      waitForBinary: async () => true,
    })),
    resolveAcpAdapterWithRetry: vi.fn(async () => ({
      command: 'stub-acp',
      args: [],
      waitForBinary: async () => true,
    })),
  };
});

import { start } from '../../../src/commands/start';
import { getActiveSession, getActiveSessionForAgent } from '../../../src/config';
import { runAcpSession, type AcpRunnerOptions } from '../../../src/agents/acp/runner';
import { startClaudeCredentialSync } from '../../../src/agents/claude/credential-sync';

const SLOW_ORCHESTRATOR_MS = 30_000;

function runnerOpts(): AcpRunnerOptions {
  expect(runAcpSession).toHaveBeenCalledTimes(1);
  return vi.mocked(runAcpSession).mock.calls[0]![0] as AcpRunnerOptions;
}

describe('start() — Claude credential-sync follows the runtime agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CODESPACES;
  });

  it(
    'a session started on another agent starts the watcher once it switches to Claude',
    async () => {
      const session = { ...fakeSessionBase, agent: 'antigravity' as const };
      vi.mocked(getActiveSession).mockReturnValue(session as never);
      vi.mocked(getActiveSessionForAgent).mockReturnValue(session as never);

      await start();
      expect(startClaudeCredentialSync).not.toHaveBeenCalled();

      const { onAgentRuntime } = runnerOpts();
      expect(onAgentRuntime).toBeTypeOf('function');
      onAgentRuntime!('codex');
      expect(startClaudeCredentialSync).not.toHaveBeenCalled();

      onAgentRuntime!('claude');
      expect(startClaudeCredentialSync).toHaveBeenCalledTimes(1);
      expect(startClaudeCredentialSync).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          pluginId: 'plugin-1',
          pluginAuthToken: 'tok-abc123',
          pollSecret: 'poll-secret',
        }),
      );

      // Switching away and back never stacks a second watcher.
      onAgentRuntime!('antigravity');
      onAgentRuntime!('claude');
      expect(startClaudeCredentialSync).toHaveBeenCalledTimes(1);
    },
    SLOW_ORCHESTRATOR_MS,
  );

  it(
    'a session started on Claude starts it at boot, and a switch back does not start another',
    async () => {
      const session = { ...fakeSessionBase, agent: 'claude' as const };
      vi.mocked(getActiveSession).mockReturnValue(session as never);
      vi.mocked(getActiveSessionForAgent).mockReturnValue(session as never);

      await start();
      expect(startClaudeCredentialSync).toHaveBeenCalledTimes(1);
      runnerOpts().onAgentRuntime!('claude');
      expect(startClaudeCredentialSync).toHaveBeenCalledTimes(1);
    },
    SLOW_ORCHESTRATOR_MS,
  );
});
