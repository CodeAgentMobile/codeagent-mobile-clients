/**
 * Composer pre-flight wiring in the Preview start pipeline (codeagent-nczt.10).
 *
 * A PHP repo (imaginer740's Yii3 app, 2026-10-09) arrives as a fresh clone:
 * composer.json, no vendor/. The pipeline must run `composer install` before
 * the dev server, skip a duplicate `composer install` the agent emits anyway,
 * and, where Composer isn't installed at all, stop with an error that says so
 * instead of booting an app with no autoloader.
 *
 * Each case stops the pipeline right after provisioning (the port is reported
 * busy and not adoptable), so no real dev server is ever spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as preview from '../../src/services/preview';
import { runPreviewStart } from '../../src/services/preview/start-orchestrator';
import type { PreviewDetection } from '@codeam/shared';

const spawnSpy = vi.fn();
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, default: actual, spawn: (...a: unknown[]) => spawnSpy(...a) };
});

const whichMock = vi.fn();
vi.mock('which', () => ({ default: (...a: unknown[]) => whichMock(...a) }));

const COMPOSER_INSTALL = {
  cmd: 'composer',
  args: [
    'install',
    '--no-interaction',
    '--no-progress',
    '--prefer-dist',
    '--ignore-platform-req=ext-*',
  ],
};

const detection: PreviewDetection = {
  framework: 'Yii3',
  command: 'php',
  args: ['-S', '0.0.0.0:8080', '-t', 'public'],
  port: 8080,
  ready_pattern: 'Development Server',
  setup_commands: [
    { cmd: 'composer', args: ['install'] },
    { cmd: 'php', args: ['yii', 'migrate'] },
  ],
};

function collectEvents() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
    },
  };
}

let runSetup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  spawnSpy.mockReset();
  whichMock.mockReset();
  vi.spyOn(preview, 'detectMissingNodeDeps').mockReturnValue(null);
  vi.spyOn(preview, 'detectMissingPhpDeps').mockReturnValue(COMPOSER_INSTALL);
  runSetup = vi.fn().mockResolvedValue({ status: 'ok', code: 0 });
  vi.spyOn(preview, 'runSetupCommand').mockImplementation(runSetup as never);
  // Stop right after provisioning: the port is held by something that isn't ours.
  vi.spyOn(preview, 'isPortListening').mockResolvedValue(true);
  vi.spyOn(preview, 'canAdoptPort').mockResolvedValue({ adopt: false, reason: 'unreachable' });
  vi.spyOn(preview, 'reclaimOwnOrphanPort').mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  preview.activePreviews.clear();
});

describe('Preview start — Composer pre-flight', () => {
  it('runs composer install when vendor/ is missing and skips the agent duplicate', async () => {
    whichMock.mockResolvedValue('/usr/local/bin/composer');
    const { emit } = collectEvents();
    await runPreviewStart({
      sessionId: 's-php-1',
      detection,
      cwd: '/tmp/yii3',
      emit: emit as never,
    });

    const ran = runSetup.mock.calls.map((c) => [c[0], c[1]]);
    expect(ran[0]).toEqual([COMPOSER_INSTALL.cmd, COMPOSER_INSTALL.args]);
    // The agent's `composer install` is dropped; its non-install step still runs.
    expect(ran).not.toContainEqual(['composer', ['install']]);
    expect(ran).toContainEqual(['php', ['yii', 'migrate']]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('fails with an actionable error when Composer is not installed', async () => {
    whichMock.mockResolvedValue(null);
    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 's-php-2',
      detection,
      cwd: '/tmp/yii3',
      emit: emit as never,
    });

    expect(runSetup).not.toHaveBeenCalled();
    const err = events.find((e) => e.type.endsWith('preview_error'));
    expect(err?.payload.message).toContain("Composer isn't installed");
  });

  it('surfaces a failed composer install instead of booting the app', async () => {
    whichMock.mockResolvedValue('/usr/local/bin/composer');
    runSetup.mockResolvedValueOnce({ status: 'failed', code: 2 });
    const { events, emit } = collectEvents();
    await runPreviewStart({
      sessionId: 's-php-3',
      detection,
      cwd: '/tmp/yii3',
      emit: emit as never,
    });

    expect(runSetup).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.type.endsWith('preview_error'));
    expect(err?.payload.message).toContain('Dependency install failed (composer install');
    expect(err?.payload.message).toContain('exit 2');
  });
});
