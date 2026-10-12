/**
 * codeagent-d3ia: a preview bring-up must read as BUSY to the host-agent, which
 * restarts onto a self-installed update only when no session child holds the
 * turn marker. A restart mid-bring-up killed the dev server + tunnel, and the
 * re-restore after the restart handed the app a new quick-tunnel URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { gate } = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = {
    promise: Promise.resolve(),
    arm(): void {
      gate.promise = new Promise<void>((resolve) => (release = resolve));
    },
    open(): void {
      release();
    },
  };
  return { gate };
});

vi.mock('../../src/services/preview/start-orchestrator', () => ({
  runPreviewStart: vi.fn(() => gate.promise),
}));

vi.mock('../../src/services/pairing.service', () => ({
  postLinkCredential: vi.fn().mockResolvedValue(undefined),
  postAiResult: vi.fn().mockResolvedValue(undefined),
  postPreviewEvent: vi.fn().mockResolvedValue({ ok: true }),
  postBeadsEvent: vi.fn().mockResolvedValue(undefined),
  postCliUpdateEvent: vi.fn().mockResolvedValue(undefined),
  postCoderabbitEvent: vi.fn().mockResolvedValue(undefined),
  postAgentReviewReport: vi.fn().mockResolvedValue(undefined),
  fetchProvisionCredential: vi.fn().mockResolvedValue(undefined),
}));

import { startPreviewFromDetection } from '../../src/commands/start/handlers';
import { __resetTurnMarkerDepth, isProcessMidTurn } from '../../src/services/turn-marker';

let home: string;
const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-preview-busy-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  __resetTurnMarkerDepth();
});
afterEach(() => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('startPreviewFromDetection — busy marker', () => {
  it('holds the turn marker for the whole bring-up and clears it after', async () => {
    gate.arm();
    const codeam = path.join(home, '.codeam');
    const done = startPreviewFromDetection(
      { sessionId: 'sess-busy-1', pluginId: 'plug-1', pluginAuthToken: 'tok' } as never,
      {
        framework: 'Vite',
        command: 'npm',
        args: ['run', 'dev'],
        port: 5173,
        ready_pattern: 'ready in',
      },
      'tok',
    );

    expect(isProcessMidTurn(process.pid, codeam)).toBe(true);
    gate.open();
    await done;
    expect(isProcessMidTurn(process.pid, codeam)).toBe(false);
  });
});
