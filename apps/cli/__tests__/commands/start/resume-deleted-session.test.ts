/**
 * codeagent-xwoy: a session deleted from the app while its host slept never
 * received `session_terminated`. Every wake resumed it: a zombie agent that
 * heartbeated while each session-scoped call answered 404/410. /reconnect's
 * 404 SESSION_NOT_FOUND is the proof — forget the session and exit 0 before
 * any agent starts.
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
  removeSession: vi.fn(),
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
  fetchCurrentPluginAuthToken: vi.fn(async () => null),
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
  createRuntimeStrategy: vi.fn(() => ({ meta: {} })),
  createInteractiveAgentStrategy: vi.fn(),
}));

vi.mock('../../../src/agents/acp/runner', () => ({
  runAcpSession: vi.fn(async () => undefined),
  surfaceStartupFailure: vi.fn(async () => undefined),
}));

vi.mock('../../../src/services/history.service', () => ({
  HistoryService: vi.fn(function () {
    return {};
  }),
}));

vi.mock('../../../src/services/output.service', () => ({
  OutputService: vi.fn(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('../../../src/services/agent.service', () => ({
  AgentLaunchError: class AgentLaunchError extends Error {},
  AgentService: vi.fn(function () {
    return {
      kill: vi.fn(),
      spawn: vi.fn(async () => {
        throw new Error('SENTINEL_SPAWN');
      }),
    };
  }),
}));

vi.mock('../../../src/services/command-relay.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/command-relay.service')>();
  return {
    ...actual,
    CommandRelayService: vi.fn(function () {
      return { setOnSessionGone: vi.fn(), start: vi.fn() };
    }),
    stopRelayWithGoodbye: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/services/terminal-ops.service', () => ({
  registerTerminalHandlers: vi.fn(),
  closeAllTerminals: vi.fn(),
}));

vi.mock('../../../src/commands/start/shutdown-tunnels', () => ({
  reapPreviewsAndExportTunnel: vi.fn(async () => undefined),
}));

import { start } from '../../../src/commands/start';
import { getActiveSession, getActiveSessionForAgent, removeSession } from '../../../src/config';
import { fetchCurrentPluginAuthToken } from '../../../src/services/pairing.service';
import { AgentService } from '../../../src/services/agent.service';

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function boot() {
  delete process.env.CODESPACES;
  const s = { ...fakeSessionBase, agent: 'aider' as const, userId: 'usr_1' };
  vi.mocked(getActiveSession).mockReturnValue(s as never);
  vi.mocked(getActiveSessionForAgent).mockReturnValue(s as never);
  return start();
}

describe('start() on a session deleted from the app', () => {
  beforeEach(() => {
    vi.mocked(removeSession).mockClear();
    vi.mocked(AgentService).mockClear();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  it('forgets the session and exits 0 without starting the agent', async () => {
    vi.mocked(fetchCurrentPluginAuthToken).mockImplementation(
      async (_s, _p, _sec, _onUserId, onSessionGone) => {
        onSessionGone?.();
        return null;
      },
    );
    await expect(boot()).rejects.toMatchObject({ code: 0 });
    expect(removeSession).toHaveBeenCalledWith('sess-1');
    expect(AgentService).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps resuming on any other reconnect failure (offline, 5xx)', async () => {
    vi.mocked(fetchCurrentPluginAuthToken).mockResolvedValue(null);
    await expect(boot()).rejects.toThrow('SENTINEL_SPAWN');
    expect(removeSession).not.toHaveBeenCalled();
  }, 30_000);
});
