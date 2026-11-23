/**
 * Deterministic Preview detection (2026-11-23): a Remix export (Pasito, Expo SDK
 * 54 + server/ + remix.json) failed on Antigravity because the agent's detect
 * one-shot never answered. Projects whose start command is certain skip the
 * agent; everything else (monorepos above all) keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectKnownProject } from '../../src/services/preview/known-project';

let dir: string;
const write = (rel: string, content: unknown): void => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'known-project-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The package.json api-v2's `expoProjectPackageJson` exports for a MOBILE project. */
const PASITO_PKG = {
  name: 'pasito',
  private: true,
  main: 'index.js',
  scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios', web: 'expo start --web' },
  dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-native': '0.81.4', 'react-dom': '19.1.0' },
};

describe('detectKnownProject — Remix exports', () => {
  it('a MOBILE export with a server → the Expo detection the agent returns, with a server note', () => {
    write('package.json', PASITO_PKG);
    write('remix.json', { kind: 'MOBILE', template: 'expo-app', server: { db: true }, env: [] });
    write('index.js', "import { registerRootComponent } from 'expo';");
    write('server/index.ts', 'export default app;');
    const got = detectKnownProject(dir);
    expect(got?.kind).toBe('remix-mobile');
    expect(got?.detection).toMatchObject({
      framework: 'Expo',
      command: 'npx',
      args: ['expo', 'start'],
      port: 8081,
      setup_commands: [],
    });
    // Never --tunnel: the Expo bring-up runs our own cloudflared.
    expect(got?.detection.args).not.toContain('--tunnel');
    expect(got?.detection.notes).toMatch(/server/);
  });

  it('a MOBILE export without a server has no note', () => {
    write('package.json', PASITO_PKG);
    write('remix.json', { kind: 'MOBILE', template: 'expo-app' });
    expect(detectKnownProject(dir)?.detection.notes).toBeUndefined();
  });

  it('an old MOBILE export without an expo dependency is still Expo (registerRootComponent entry)', () => {
    write('package.json', { main: 'index.js', dependencies: { 'expo-status-bar': '~3.0.0' } });
    write('remix.json', { template: 'unknown' });
    write('index.js', "import { registerRootComponent } from 'expo';\nregisterRootComponent(App);");
    expect(detectKnownProject(dir)?.kind).toBe('remix-mobile');
  });

  it('a WEB export (only a build script) → the vite binary on 0.0.0.0:5173', () => {
    write('package.json', { scripts: { build: 'vite build' }, devDependencies: { vite: '7.1.12' } });
    write('remix.json', { kind: 'WEB', template: 'vite-react' });
    expect(detectKnownProject(dir)).toEqual({
      kind: 'remix-web',
      detection: {
        framework: 'Vite',
        command: 'npx',
        args: ['vite', '--host', '0.0.0.0', '--port', '5173'],
        port: 5173,
        ready_pattern: 'Local:.*http',
        env: {},
        setup_commands: [],
      },
    });
  });

  it('a WEB export with a `vite` dev script runs it, keeping its port', () => {
    write('package.json', { scripts: { dev: 'vite --port 3001' }, devDependencies: { vite: '7' } });
    write('remix.json', { kind: 'WEB_DATA', template: 'vite-vanilla' });
    const got = detectKnownProject(dir);
    expect(got?.detection).toMatchObject({
      command: 'npm',
      args: ['run', 'dev', '--', '--host', '0.0.0.0'],
      port: 3001,
    });
  });

  it('a WEB export with no vite at all → agent', () => {
    write('package.json', { scripts: { build: 'tsc' } });
    write('remix.json', { kind: 'WEB' });
    expect(detectKnownProject(dir)).toBeNull();
  });
});

describe('detectKnownProject — plain projects', () => {
  it('a plain Expo app (expo dep + app.json) → Expo', () => {
    write('package.json', { scripts: { start: 'expo start' }, dependencies: { expo: '~54.0.0' } });
    write('app.json', { expo: { name: 'x' } });
    expect(detectKnownProject(dir)?.kind).toBe('expo');
  });

  it('expo without an app config → agent', () => {
    write('package.json', { dependencies: { expo: '~54.0.0' } });
    expect(detectKnownProject(dir)).toBeNull();
  });

  it('a plain Vite app with `dev: vite` → npm run dev on 0.0.0.0', () => {
    write('package.json', { scripts: { dev: 'vite' }, devDependencies: { vite: '7' } });
    expect(detectKnownProject(dir)).toEqual({
      kind: 'vite',
      detection: expect.objectContaining({
        framework: 'Vite',
        command: 'npm',
        args: ['run', 'dev', '--', '--host', '0.0.0.0'],
        port: 5173,
      }),
    });
  });

  it('keeps an explicit --host in the dev script', () => {
    write('package.json', { scripts: { dev: 'vite --host' }, devDependencies: { vite: '7' } });
    expect(detectKnownProject(dir)?.detection.args).toEqual(['run', 'dev']);
  });

  it('a dev script that is not plain vite (concurrently, next, …) → agent', () => {
    write('package.json', { scripts: { dev: 'concurrently "vite" "node server.js"' }, devDependencies: { vite: '7' } });
    expect(detectKnownProject(dir)).toBeNull();
    write('package.json', { scripts: { dev: 'next dev' }, dependencies: { next: '15' } });
    expect(detectKnownProject(dir)).toBeNull();
  });

  it('vite without a dev script → agent (outside a Remix export)', () => {
    write('package.json', { devDependencies: { vite: '7' } });
    expect(detectKnownProject(dir)).toBeNull();
  });

  it('no package.json, or unreadable JSON → agent', () => {
    expect(detectKnownProject(dir)).toBeNull();
    write('package.json', '{ not json');
    expect(detectKnownProject(dir)).toBeNull();
  });
});

describe('detectKnownProject — monorepos keep the agent path', () => {
  it.each([
    ['package.json workspaces', () => write('package.json', { workspaces: ['apps/*'], scripts: { dev: 'vite' } })],
    ['pnpm-workspace.yaml', () => {
      write('package.json', { scripts: { dev: 'vite' } });
      write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    }],
    ['nx.json', () => {
      write('package.json', { dependencies: { expo: '~54.0.0' } });
      write('app.json', {});
      write('nx.json', {});
    }],
    ['turbo.json + remix.json', () => {
      write('package.json', PASITO_PKG);
      write('remix.json', { kind: 'MOBILE' });
      write('turbo.json', {});
    }],
  ])('%s → null', (_label, setup) => {
    setup();
    expect(detectKnownProject(dir)).toBeNull();
  });
});

describe('resolvePreviewDetection uses it before the agent', () => {
  it('returns the Expo detection without invoking the one-shot (and works on a runtime without one)', async () => {
    vi.resetModules();
    vi.doMock('../../src/services/pairing.service', () => ({
      postLinkCredential: vi.fn().mockResolvedValue(undefined),
      postAiResult: vi.fn().mockResolvedValue(undefined),
      postPreviewEvent: vi.fn().mockResolvedValue({ ok: true }),
      postBeadsEvent: vi.fn().mockResolvedValue(undefined),
      postCliUpdateEvent: vi.fn().mockResolvedValue(undefined),
      postCoderabbitEvent: vi.fn().mockResolvedValue(undefined),
      postAgentReviewReport: vi.fn().mockResolvedValue(undefined),
      fetchProvisionCredential: vi.fn().mockResolvedValue(undefined),
    }));
    const { resolvePreviewDetection } = await import('../../src/commands/start/handlers');
    write('package.json', PASITO_PKG);
    write('remix.json', { kind: 'MOBILE', template: 'expo-app' });
    write('App.tsx', 'export default function App() { return null; }');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      type Runtime = Parameters<typeof resolvePreviewDetection>[0]['runtime'];
      const generateOneShot = vi.fn();
      for (const runtime of [{ id: 'antigravity', generateOneShot }, { id: 'aider' }]) {
        const got = await resolvePreviewDetection({
          ctx: { sessionId: 's', pluginId: 'p' },
          runtime: runtime as unknown as Runtime,
          pluginAuthToken: 't',
          origin: 'agent',
        });
        expect(got?.framework).toBe('Expo');
      }
      expect(generateOneShot).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
      vi.doUnmock('../../src/services/pairing.service');
    }
  });
});
