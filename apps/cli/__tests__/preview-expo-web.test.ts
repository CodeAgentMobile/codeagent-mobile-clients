import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expoWebDepsInstall,
  expoWebInstallSpecs,
  missingExpoWebPackages,
} from '../src/services/preview/expo';

function project(installed: string[], pins?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeam-expo-web-'));
  for (const name of ['expo', ...installed]) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), '{}');
  }
  if (pins) writeFileSync(join(dir, 'node_modules', 'expo', 'bundledNativeModules.json'), JSON.stringify(pins));
  return dir;
}

describe('the Expo WEB preview installs what Metro needs to serve a browser (owner 2026-10-31)', () => {
  it('a project without the web packages gets them at the SDK’s versions, --no-save', () => {
    const dir = project([], { 'react-native-web': '~0.21.0', 'react-dom': '19.1.0', '@expo/metro-runtime': '~6.1.2' });
    expect(missingExpoWebPackages(dir)).toEqual(['react-native-web', 'react-dom', '@expo/metro-runtime']);
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

  it('everything present: no install', () => {
    const dir = project(['react-native-web', 'react-dom', '@expo/metro-runtime']);
    expect(expoWebDepsInstall(dir)).toBeNull();
  });
});
