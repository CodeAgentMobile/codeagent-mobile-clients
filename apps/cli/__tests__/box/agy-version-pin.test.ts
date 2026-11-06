import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The Box image bakes Antigravity CLI (`agy`) at an EXACT release, sha512-
 * verified, into /usr/local/bin (outside the runtime-shadowed /home/box), with
 * its background self-update turned off. The official install.sh always pulls
 * the LATEST manifest and agy relaunches itself after an update, so without
 * these a rebuild floats and a live `agy acp` session can have its binary
 * swapped underneath it.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'apps/box/Dockerfile'), 'utf8');

function arg(name: string): string {
  return new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1] ?? '';
}

describe('Antigravity CLI (agy) pin in the Box image', () => {
  it('pins an exact release and a sha512 per architecture', () => {
    expect(arg('AGY_RELEASE')).toMatch(/^\d+\.\d+\.\d+-\d+$/);
    expect(arg('AGY_SHA512_AMD64')).toMatch(/^[0-9a-f]{128}$/);
    expect(arg('AGY_SHA512_ARM64')).toMatch(/^[0-9a-f]{128}$/);
  });

  it('downloads through the pinned release and verifies the checksum', () => {
    expect(dockerfile).toContain(
      'https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_RELEASE}/',
    );
    expect(dockerfile).toMatch(/sha512sum -c -/);
    // Never the floating installer, which always resolves the latest manifest.
    expect(dockerfile).not.toContain('antigravity.google/cli/install.sh');
  });

  it('installs to /usr/local/bin, not under the shadowed /home/box volume', () => {
    expect(dockerfile).toContain('install -m 0755 /tmp/antigravity /usr/local/bin/agy');
    expect(dockerfile).toMatch(/agy --version/);
  });

  it('disables the background self-update for every box process', () => {
    expect(dockerfile).toMatch(/^ENV AGY_CLI_DISABLE_AUTO_UPDATE=1$/m);
  });
});
