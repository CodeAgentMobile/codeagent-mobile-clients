/**
 * Antigravity `auto` on a host without agy's terminal sandbox (owner's
 * codespace, 2026-11-24): `agy acp` accepts `session/set_mode auto` and then
 * runs every command in its namespace sandbox, which a container without user
 * namespaces refuses — "Command failed to run: fork/exec /usr/local/bin/agy:
 * operation not permitted" for `git status`, `ls`, `curl`. There the client
 * keeps `auto` on the picker, sets agy `default` (asks, then runs outside the
 * sandbox), and the CLI's own permission gate approves.
 */
import { describe, it, expect, vi } from 'vitest';
import { AcpClient } from '../../../src/agents/acp/client';
import type { AcpClientOptions } from '../../../src/agents/acp/client';
import type { AdapterSpec } from '../../../src/agents/acp/adapters';
import { antigravityModeSubstitutes } from '../../../src/agents/antigravity/terminal-sandbox';

const AGY_MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Ask before edits and commands.' },
    { id: 'accept-edits', name: 'Accept edits' },
    { id: 'auto', name: 'Auto', description: 'Approve edits and safe commands.' },
    { id: 'plan', name: 'Plan' },
  ],
};

interface Internals {
  connection: {
    newSession: ReturnType<typeof vi.fn>;
    setSessionMode: ReturnType<typeof vi.fn>;
  } | null;
  sessionId: string | null;
}

function makeClient(sandboxAvailable: boolean): {
  client: AcpClient;
  setSessionMode: ReturnType<typeof vi.fn>;
} {
  const adapter: AdapterSpec = {
    command: 'agy',
    args: ['acp'],
    requiresAgentBinary: 'agy',
    waitForBinary: async () => true,
    modeSubstitutes: antigravityModeSubstitutes(sandboxAvailable),
  };
  const opts: AcpClientOptions = {
    adapter,
    cwd: '/tmp/w',
    onSessionUpdate: () => undefined,
    onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  };
  const client = new AcpClient(opts);
  const setSessionMode = vi.fn(async () => undefined);
  const internals = client as unknown as Internals;
  internals.connection = {
    newSession: vi.fn(async () => ({ sessionId: 'sess-1', modes: AGY_MODES, configOptions: [] })),
    setSessionMode,
  };
  return { client, setSessionMode };
}

describe('Antigravity auto mode without the terminal sandbox', () => {
  it('sends agy `default` for `auto`, keeps reporting `auto`, and auto-approves', async () => {
    const { client, setSessionMode } = makeClient(false);
    await client.newConversation();
    await client.setMode('auto');

    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-1', modeId: 'default' });
    expect(client.getCurrentModeId()).toBe('auto');
    expect(client.modeAutoApproves('auto')).toBe(true);
    expect(client.modeAutoApproves('default')).toBe(false);
    expect(client.getAvailableModes().find((m) => m.id === 'auto')?.description).toMatch(
      /guardrails still apply/,
    );
  });

  it('moves a session agy restored in `auto` onto `default`', async () => {
    const { client, setSessionMode } = makeClient(false);
    const internals = client as unknown as Internals;
    internals.connection!.newSession = vi.fn(async () => ({
      sessionId: 'sess-2',
      modes: { ...AGY_MODES, currentModeId: 'auto' },
      configOptions: [],
    }));
    await client.newConversation();

    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-2', modeId: 'default' });
    expect(client.getCurrentModeId()).toBe('auto');
  });

  it('other modes pass through unchanged', async () => {
    const { client, setSessionMode } = makeClient(false);
    await client.newConversation();
    await client.setMode('accept-edits');
    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-1', modeId: 'accept-edits' });
    expect(client.modeAutoApproves('accept-edits')).toBe(false);
  });

  it('where the sandbox works, `auto` is agy’s own mode', async () => {
    const { client, setSessionMode } = makeClient(true);
    await client.newConversation();
    await client.setMode('auto');
    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-1', modeId: 'auto' });
    expect(client.modeAutoApproves('auto')).toBe(false);
  });
});
