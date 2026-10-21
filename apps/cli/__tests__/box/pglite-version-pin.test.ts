import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The Box image must install PGlite at EXACT versions. An unpinned install
 * resolved a pglite-socket whose exact peer `pglite-pgtap` was still
 * mid-publish upstream, and the v2.76.34 image build died on npm ETARGET
 * (2026-10-21). pglite-socket pins its peers exactly, so pinning socket +
 * pglite pins the whole set.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'apps/box/Dockerfile'), 'utf8');

function arg(name: string): string {
  return new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1] ?? '';
}

describe('PGlite version pin in the Box image', () => {
  it('pins exact versions', () => {
    expect(arg('PGLITE_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(arg('PGLITE_SOCKET_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('installs pglite and pglite-socket through the pinned ARGs only', () => {
    expect(dockerfile).toContain('"@electric-sql/pglite@${PGLITE_VERSION}"');
    expect(dockerfile).toContain('"@electric-sql/pglite-socket@${PGLITE_SOCKET_VERSION}"');
    // No unpinned install of any @electric-sql package anywhere in the image.
    expect(dockerfile).not.toMatch(/@electric-sql\/[\w-]+\s*\\/);
  });
});
