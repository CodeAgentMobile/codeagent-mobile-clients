import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expoSdkOf,
  expoWebDepsInstall,
  expoWebInstallSpecs,
  missingExpoPackages,
  missingExpoWebPackages,
} from '../src/services/preview/expo';

function project(installed: string[], pins?: Record<string, string>, withExpo = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeam-expo-web-'));
  for (const name of [...(withExpo ? ['expo'] : []), ...installed]) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), '{}');
  }
  if (pins)
    writeFileSync(
      join(dir, 'node_modules', 'expo', 'bundledNativeModules.json'),
      JSON.stringify(pins),
    );
  return dir;
}

describe('the Expo WEB preview installs what Metro needs to serve a browser (owner 2026-10-31)', () => {
  it('a project without the web packages gets them at the SDK’s versions, --no-save', () => {
    const dir = project([], {
      'react-native-web': '~0.21.0',
      'react-dom': '19.1.0',
      '@expo/metro-runtime': '~6.1.2',
    });
    expect(missingExpoWebPackages(dir)).toEqual([
      'react-native-web',
      'react-dom',
      '@expo/metro-runtime',
    ]);
    expect(expoWebDepsInstall(dir)).toEqual({
      cmd: 'npm',
      args: [
        'install',
        '--no-save',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        'react-native-web@~0.21.0',
        'react-dom@19.1.0',
        '@expo/metro-runtime@~6.1.2',
      ],
    });
  });

  it('only what is missing; an SDK without pins gives bare names', () => {
    const dir = project(['react-dom']);
    expect(missingExpoWebPackages(dir)).toEqual(['react-native-web', '@expo/metro-runtime']);
    expect(expoWebInstallSpecs(dir, ['react-native-web'])).toEqual(['react-native-web']);
  });

  it('a Remix MOBILE export without `expo` itself (react-native 0.81): expo at SDK 54 + the web packages, --no-save', () => {
    const dir = project(['react-native'], undefined, false);
    writeFileSync(
      join(dir, 'node_modules', 'react-native', 'package.json'),
      '{"version":"0.81.4"}',
    );
    expect(missingExpoPackages(dir)).toEqual([
      'expo',
      'react-native-web',
      'react-dom',
      '@expo/metro-runtime',
    ]);
    expect(expoSdkOf(dir)).toBe('54');
    expect(expoWebDepsInstall(dir)?.args.slice(5)).toEqual([
      'expo@~54.0.0',
      'react-native-web@~0.21.0',
      'react-dom@19.1.0',
      '@expo/metro-runtime@~6.1.2',
    ]);
  });

  it('an unknown react-native: `expo` bare, the web packages bare', () => {
    const dir = project(['react-native'], undefined, false);
    writeFileSync(
      join(dir, 'node_modules', 'react-native', 'package.json'),
      '{"version":"0.99.0"}',
    );
    expect(expoSdkOf(dir)).toBeNull();
    expect(expoWebDepsInstall(dir)?.args.slice(5)).toEqual([
      'expo',
      'react-native-web',
      'react-dom',
      '@expo/metro-runtime',
    ]);
  });

  it('everything present: no install', () => {
    const dir = project(['react-native-web', 'react-dom', '@expo/metro-runtime']);
    expect(expoWebDepsInstall(dir)).toBeNull();
  });
});
