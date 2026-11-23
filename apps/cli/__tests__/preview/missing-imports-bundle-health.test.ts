/**
 * Owner's codespace, 2026-11-23: a Remix export imported `expo-clipboard` / `expo-sqlite` without
 * declaring them (the players supply them), Metro answered the bundle with a 500 and the Preview
 * was a white page announced as ready. The CLI now installs what the app imports, and a build
 * error is a `preview_error` with Metro's text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  aliasPrefixes,
  expoInstallCommand,
  findMissingImports,
  importSpecifiers,
  packageOf,
} from '../../src/services/preview/missing-imports';
import {
  addPreviewGitExcludes,
  bundleErrorText,
  checkAppBundle,
  entryScriptOf,
} from '../../src/services/preview/bundle-health';

let dir: string;
const write = (rel: string, content: unknown): void => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'missing-imports-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('import scan', () => {
  it('finds static, side-effect, dynamic and require imports, not commented ones', () => {
    const src = [
      "import * as Clipboard from 'expo-clipboard';",
      "import { Storage } from 'expo-sqlite/kv-store';",
      "import 'react-native-gesture-handler';",
      "export { x } from './local';",
      "const m = await import('@scope/pkg/sub');",
      "const r = require('lodash');",
      "// import nope from 'commented-out';",
      "/* import alsoNope from 'block-commented'; */",
      "const url = 'https://example.com/x';",
    ].join('\n');
    expect(importSpecifiers(src).sort()).toEqual(
      ['./local', '@scope/pkg/sub', 'expo-clipboard', 'expo-sqlite/kv-store', 'lodash', 'react-native-gesture-handler'].sort(),
    );
  });
  it('maps a specifier to its package, skipping relative, built-ins, aliases and invalid names', () => {
    expect(packageOf('expo-sqlite/kv-store', [])).toBe('expo-sqlite');
    expect(packageOf('@react-navigation/native/lib', [])).toBe('@react-navigation/native');
    expect(packageOf('./x', [])).toBeNull();
    expect(packageOf('fs', [])).toBeNull();
    expect(packageOf('node:path', [])).toBeNull();
    expect(packageOf('@/components/Button', ['@'])).toBeNull();
    expect(packageOf('~/lib', [])).toBeNull(); // not an npm name
    expect(packageOf('components/Button', ['components'])).toBeNull();
  });
  it('reads aliases from tsconfig paths (with comments) and babel module-resolver', () => {
    write('tsconfig.json', '{ // comment\n "compilerOptions": { "paths": { "@app/*": ["src/*"], "ui": ["src/ui"] } }, }');
    write('babel.config.js', "module.exports = { plugins: [['module-resolver', { alias: { 'components': './src/components', '@lib': './lib' } }]] };");
    expect(aliasPrefixes(dir).sort()).toEqual(['@app', '@lib', 'components', 'ui'].sort());
  });
  it('lists packages neither declared nor installed, outside server/ and node_modules', () => {
    write('package.json', { dependencies: { expo: '~54.0.0', react: '19.1.0' } });
    write('App.tsx', "import React from 'react';\nimport { Text } from 'react-native';\nimport * as C from 'expo-clipboard';");
    write('src/db.ts', "import { Storage } from 'expo-sqlite/kv-store';\nimport x from '@app/thing';");
    write('tsconfig.json', { compilerOptions: { paths: { '@app/*': ['src/*'] } } });
    write('server/index.ts', "import { Hono } from 'hono';");
    write('node_modules/react-native/package.json', { name: 'react-native' });
    write('node_modules/some-dep/index.js', "require('not-mine');");
    expect(findMissingImports(dir)).toEqual(['expo-clipboard', 'expo-sqlite']);
  });
  it('installs through the project expo binary with --legacy-peer-deps', () => {
    expect(expoInstallCommand(dir, ['expo-clipboard']).args).toEqual([
      '--yes', 'expo', 'install', 'expo-clipboard', '--', '--legacy-peer-deps',
    ]);
    write('node_modules/.bin/expo', '#!/bin/sh');
    expect(expoInstallCommand(dir, ['a', 'b'])).toEqual({
      cmd: path.join(dir, 'node_modules', '.bin', 'expo'),
      args: ['install', 'a', 'b', '--', '--legacy-peer-deps'],
    });
  });
});

describe('bundle health', () => {
  it('finds Metro bundles and Vite module entries in the page', () => {
    expect(entryScriptOf('<script src="/index.bundle?platform=web&dev=true" defer></script>')).toBe(
      '/index.bundle?platform=web&dev=true',
    );
    expect(
      entryScriptOf('<script type="module" src="/@vite/client"></script><script type="module" src="./src/main.tsx"></script>'),
    ).toBe('./src/main.tsx');
    expect(entryScriptOf('<script src="/static/app.js"></script>')).toBeNull();
  });
  it("reads Metro's JSON error message", () => {
    const body = JSON.stringify({
      type: 'UnableToResolveError',
      message: '\u001b[31mUnable to resolve module expo-clipboard from src/screens/parent/FamilyScreen.tsx\u001b[39m',
    });
    expect(bundleErrorText(body)).toBe('Unable to resolve module expo-clipboard from src/screens/parent/FamilyScreen.tsx');
  });

  const serve = (handler: http.RequestListener): Promise<http.Server> =>
    new Promise((resolve) => {
      const s = http.createServer(handler);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
  const portOf = (s: http.Server): number => (s.address() as AddressInfo).port;

  it('a bundle 500 is a failure with the build text; a 200 is ok', async () => {
    let broken = true;
    const metro = await serve((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><script src="/index.bundle?platform=web"></script></html>');
      } else if (broken) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Unable to resolve module expo-clipboard' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('var a=1');
      }
    });
    try {
      expect(await checkAppBundle(portOf(metro))).toEqual({
        ok: false,
        status: 500,
        error: 'Unable to resolve module expo-clipboard',
      });
      broken = false;
      expect(await checkAppBundle(portOf(metro))).toEqual({ ok: true });
    } finally {
      metro.close();
    }
  });
  it('a slow bundle is inconclusive, never a failure', async () => {
    const metro = await serve((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<script src="/index.bundle"></script>');
      } else setTimeout(() => res.end('late'), 2_000);
    });
    try {
      expect((await checkAppBundle(portOf(metro), { bundleTimeoutMs: 100 })).ok).toBe('unknown');
    } finally {
      metro.closeAllConnections();
      metro.close();
    }
  });
});

describe('git exclude', () => {
  it('adds our runtime paths once, keeping what the file had', () => {
    const file = path.join(dir, '.git', 'info', 'exclude');
    write('.git/info/exclude', '# git ls-files --others --exclude-from=.git/info/exclude\n*.local');
    expect(addPreviewGitExcludes(file)).toBe(true);
    expect(addPreviewGitExcludes(file)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(
      '# git ls-files --others --exclude-from=.git/info/exclude\n*.local\n' +
        '# CodeAgent preview runtime files\n/.wrangler/\n/.codeam/*\n!/.codeam/preview.json\n',
    );
  });
});
