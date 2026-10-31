import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectMissingNodeDeps, missingDeclaredDep } from '../src/services/preview/setup-deps';

function project(deps: Record<string, string>, installed: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeam-preview-deps-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }));
  for (const name of installed) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), '{}');
  }
  return dir;
}

describe('the preview installs when a declared dependency is missing (2026-10-31, expo not installed)', () => {
  it('a node_modules/ built before `expo` was added still gets an install', () => {
    const dir = project({ react: '19.0.0', expo: '~54.0.0' }, ['react']);
    expect(missingDeclaredDep(dir)).toBe('expo');
    expect(detectMissingNodeDeps(dir)).toEqual({
      cmd: 'npm',
      args: ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'],
    });
  });

  it('every declared dependency present: no install', () => {
    const dir = project({ react: '19.0.0', expo: '~54.0.0' }, ['react', 'expo']);
    expect(missingDeclaredDep(dir)).toBeNull();
    expect(detectMissingNodeDeps(dir)).toBeNull();
  });

  it('no node_modules at all installs, as before', () => {
    const dir = project({ react: '19.0.0' }, []);
    expect(detectMissingNodeDeps(dir)?.cmd).toBe('npm');
  });
});
