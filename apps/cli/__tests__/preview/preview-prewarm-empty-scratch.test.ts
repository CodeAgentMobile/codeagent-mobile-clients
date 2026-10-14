/**
 * The preview PREWARM must not bill an agent one-shot for an empty scratch
 * project.
 *
 * 2026-10-14 (PRO user's first CodeAgent Box, "Start from scratch", managed
 * agent on credits): 20 s after pairing — before the user had typed anything —
 * the prewarm ran the headless detect one-shot on the still-empty workspace and
 * three debits hit the user's wallet. The answer ("unsupported") is never
 * cached, so it repeats on every box wake. The on-demand detect already
 * short-circuits an empty scratch project (#889); the prewarm did not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeStrategy } from '../../src/agents/strategy';

let dir: string;

function makeScratch(): void {
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'codeam-scratch'), '');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# notes');
}

async function prewarmWith(generateOneShot: RuntimeStrategy['generateOneShot']): Promise<void> {
  // The prewarm is once-per-process: load a fresh module for every case.
  vi.resetModules();
  const { prewarmPreviewDetection } = await import('../../src/commands/start/handlers');
  const runtime = { id: 'claude', generateOneShot } as unknown as RuntimeStrategy;
  prewarmPreviewDetection(runtime);
  // The prewarm body is fire-and-forget; let its awaits settle.
  await vi.waitFor(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-prewarm-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('prewarmPreviewDetection', () => {
  it('skips the agent one-shot for an untouched scratch project', async () => {
    makeScratch();
    const generateOneShot = vi.fn().mockResolvedValue('{"framework":"unsupported"}');
    await prewarmWith(generateOneShot);
    expect(generateOneShot).not.toHaveBeenCalled();
  });

  it('still prewarms once the scratch project has something to serve', async () => {
    makeScratch();
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
    const generateOneShot = vi.fn().mockResolvedValue('{"framework":"unsupported"}');
    await prewarmWith(generateOneShot);
    expect(generateOneShot).toHaveBeenCalledTimes(1);
  });
});
