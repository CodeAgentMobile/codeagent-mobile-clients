import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The Box image's global bd and the CLI's `@beads/bd` pin must be the SAME
 * exact version. They drifted once (CLI 1.0.5 — whose release binaries 404 —
 * vs an unpinned image that baked 1.3.1) and every DB on an existing volume
 * broke on schema skew (2026-10-21). Bump both together.
 */
const ROOT = path.resolve(__dirname, '../../../..');

function cliPin(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/cli/package.json'), 'utf8')) as {
    optionalDependencies?: Record<string, string>;
  };
  return pkg.optionalDependencies?.['@beads/bd'] ?? '';
}

function boxPin(): string {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'apps/box/Dockerfile'), 'utf8');
  return /^ARG BEADS_BD_VERSION=(\S+)$/m.exec(dockerfile)?.[1] ?? '';
}

describe('@beads/bd version pin', () => {
  it('the CLI pins an exact version', () => {
    expect(cliPin()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the Box image installs exactly the CLI pin', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'apps/box/Dockerfile'), 'utf8');
    expect(boxPin()).toBe(cliPin());
    expect(dockerfile).toContain('"@beads/bd@${BEADS_BD_VERSION}"');
    // No second, unpinned install of bd anywhere in the image.
    expect(dockerfile).not.toMatch(/@beads\/bd\s*\\/);
  });
});
