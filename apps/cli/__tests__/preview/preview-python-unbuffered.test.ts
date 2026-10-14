/**
 * codeagent-nczt.9 (2026-10-14): for a plain HTML site the detector answers
 * `python3 -m http.server 8000 --bind 0.0.0.0` with ready_pattern
 * "Serving HTTP on". Python block-buffers stdout when it is a pipe, so that
 * banner never reached the CLI while the server was already answering 200 —
 * every such preview sat in WAITING_FOR_READY for the full 120 s and ended in
 * `ready_timeout` (static/custom frameworks, ~14 users in 30 days, Box and
 * codespaces alike).
 *
 * What must hold: a real `python3 -m http.server` becomes ready from its own
 * banner, well inside the readiness window.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/preview/inspector-bringup', () => ({
  bringUpInspector: async (port: number) => ({ port, proxy: null }),
}));

import * as preview from '../../src/services/preview';
import { runPreviewStart } from '../../src/services/preview/start-orchestrator';

function hasPython3(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

let root: string;
const savedUnbuffered = process.env.PYTHONUNBUFFERED;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nczt9-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><h1>NovaEdge</h1>');
  // The CLI's own env must not mask the bug (a dev shell may export it).
  delete process.env.PYTHONUNBUFFERED;
  // Stop right after the dev server is up: no cloudflared here.
  vi.spyOn(preview, 'resolveCloudflared').mockRejectedValue(new Error('no cloudflared in tests'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of [...preview.activePreviews.keys()]) await preview.killPreview(id);
  preview.activePreviews.clear();
  if (savedUnbuffered === undefined) delete process.env.PYTHONUNBUFFERED;
  else process.env.PYTHONUNBUFFERED = savedUnbuffered;
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasPython3())('static site served by python3 -m http.server', () => {
  it('is ready from its "Serving HTTP on" banner, not after the 120 s timeout', async () => {
    const port = await freePort();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const startedAt = Date.now();
    await runPreviewStart({
      sessionId: 'nczt9-static',
      // Verbatim shape of what the detector returns for an index.html site.
      detection: {
        framework: 'static',
        command: 'python3',
        args: ['-m', 'http.server', String(port), '--bind', '0.0.0.0'],
        port,
        ready_pattern: 'Serving HTTP on',
      },
      cwd: root,
      emit: ((type: string, payload: Record<string, unknown>) =>
        events.push({ type, payload })) as never,
    });

    const error = events.find((e) => e.type.endsWith('preview_error'))?.payload;
    expect(error?.stage).not.toBe('ready_timeout');
    expect(events.some((e) => e.payload.step === 'READY_DETECTED')).toBe(true);
    // The pipeline only stopped at the (absent) tunnel.
    expect(error).toMatchObject({ stage: 'tunnel' });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }, 30_000);
});
