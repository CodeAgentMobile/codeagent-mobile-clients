/**
 * codeagent-hz3h (2026-10-12): a FastAPI app the agent built in `teleshop/`,
 * venv at `teleshop/.venv`. The detection said `.venv/bin/python`, the spawn
 * ran at the workspace root, and every start died `spawn .venv/bin/python
 * ENOENT` (an uncaughtException in the box log) — shown to the user as
 * "exited (code -2) … may need a database".
 *
 * What must hold:
 *   - `detection.cwd` runs the dev server inside that folder (real spawn);
 *   - a folder outside the project, or a missing one, is refused with the
 *     reason before anything spawns;
 *   - a command that can't be found says so, instead of blaming a database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewDetection } from '@codeam/shared';

const spawnCalls: Array<{ command: string; cwd: unknown }> = [];
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  const spawn = (command: string, args: string[], opts: { cwd?: unknown }) => {
    spawnCalls.push({ command, cwd: opts?.cwd });
    return actual.spawn(command, args, opts as never);
  };
  return { ...actual, default: { ...actual, spawn }, spawn };
});
vi.mock('../../src/services/preview/inspector-bringup', () => ({
  bringUpInspector: async (port: number) => ({ port, proxy: null }),
}));

import * as preview from '../../src/services/preview';
import { resolveDetectionCwd } from '../../src/services/preview/detection-cwd';
import {
  describeSpawnFailure,
  runPreviewStart,
} from '../../src/services/preview/start-orchestrator';

let root: string;

function collect() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
    error: () => events.find((e) => e.type.endsWith('preview_error'))?.payload,
  };
}

function pythonApp(): PreviewDetection {
  return {
    framework: 'FastAPI',
    command: '.venv/bin/python',
    args: ['-m', 'uvicorn', 'main:app'],
    port: 8000,
    ready_pattern: 'Application startup complete',
  };
}

beforeEach(() => {
  spawnCalls.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hz3h-'));
  // The project from the incident: nothing runnable at the root, the app and
  // its venv in a subfolder. The "python" prints uvicorn's ready line.
  const bin = path.join(root, 'teleshop', '.venv', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'python'),
    '#!/bin/sh\necho "INFO:     Application startup complete."\nsleep 30\n',
    { mode: 0o755 },
  );
  vi.spyOn(preview, 'isPortListening').mockResolvedValue(false);
  // Stop right after the dev server is up: no cloudflared here.
  vi.spyOn(preview, 'resolveCloudflared').mockRejectedValue(new Error('no cloudflared in tests'));
});
afterEach(() => {
  vi.restoreAllMocks();
  preview.activePreviews.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveDetectionCwd', () => {
  it('absent or "." is the workspace root', () => {
    expect(resolveDetectionCwd(root, undefined)).toEqual({ ok: true, dir: root });
    expect(resolveDetectionCwd(root, '.')).toEqual({ ok: true, dir: root });
    expect(resolveDetectionCwd(root, '  ')).toEqual({ ok: true, dir: root });
  });

  it('resolves a subfolder inside the project', () => {
    expect(resolveDetectionCwd(root, 'teleshop')).toEqual({
      ok: true,
      dir: path.join(root, 'teleshop'),
    });
    expect(resolveDetectionCwd(root, './teleshop/')).toEqual({
      ok: true,
      dir: path.join(root, 'teleshop'),
    });
  });

  it('refuses a folder outside the project, relative or absolute', () => {
    for (const bad of ['..', '../other', 'teleshop/../../etc', '/etc']) {
      const r = resolveDetectionCwd(root, bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toContain('outside this project');
    }
  });

  it('refuses a folder that does not exist (or is a file)', () => {
    const r = resolveDetectionCwd(root, 'nope');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toContain("doesn't exist");
    expect(resolveDetectionCwd(root, 'teleshop/.venv/bin/python')).toMatchObject({ ok: false });
  });
});

describe('runPreviewStart with an app in a subfolder', () => {
  // The fixture "python" is a `#!/bin/sh` script; Windows can't exec it (and a
  // Windows venv is `.venv\Scripts\python.exe` anyway). Previews run on the
  // Linux box/codespace, which the POSIX runners cover.
  it.skipIf(process.platform === 'win32')('spawns the dev server INSIDE detection.cwd and gets it ready', async () => {
    const { events, emit, error } = collect();
    await runPreviewStart({
      sessionId: 'hz3h-1',
      detection: { ...pythonApp(), cwd: 'teleshop' },
      cwd: root,
      emit: emit as never,
    });

    expect(spawnCalls.find((c) => c.command === '.venv/bin/python')?.cwd).toBe(
      path.join(root, 'teleshop'),
    );
    // The dev server came up: the pipeline only stopped at the (absent) tunnel.
    expect(events.some((e) => e.payload.step === 'READY_DETECTED')).toBe(true);
    expect(error()).toMatchObject({ stage: 'tunnel' });
  }, 15_000);

  it('without cwd the same command names what is missing — not a database', async () => {
    const { emit, error } = collect();
    await runPreviewStart({
      sessionId: 'hz3h-2',
      detection: pythonApp(),
      cwd: root,
      emit: emit as never,
    });

    expect(error()).toMatchObject({ stage: 'spawn' });
    expect(String(error()?.message)).toContain(
      '".venv/bin/python" was not found in the project root',
    );
    expect(String(error()?.message)).not.toContain('database');
  }, 15_000);

  it('refuses a cwd outside the project before spawning anything', async () => {
    const { emit, error } = collect();
    await runPreviewStart({
      sessionId: 'hz3h-3',
      detection: { ...pythonApp(), cwd: '../elsewhere' },
      cwd: root,
      emit: emit as never,
    });

    expect(spawnCalls).toHaveLength(0);
    expect(error()).toMatchObject({ stage: 'spawn' });
    expect(String(error()?.message)).toContain('outside this project');
  });
});

describe('describeSpawnFailure', () => {
  it('is null when the process did start', () => {
    expect(describeSpawnFailure(null, 'npm', '')).toBeNull();
  });

  it('names the folder it looked in', () => {
    const enoent = Object.assign(new Error('spawn uvicorn ENOENT'), { code: 'ENOENT' });
    expect(describeSpawnFailure(enoent, 'uvicorn', 'teleshop')).toContain(
      'in the "teleshop" folder',
    );
  });
});
