import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  BAKED_TOOLS_DIR,
  WRANGLER_VERSION_NODE22,
} from '../../src/services/preview/remix-app-server';

/**
 * The Box image bakes wrangler so the first Remix app-server Preview doesn't download ~100 MB.
 * The CLI only runs the baked one when it is EXACTLY its own pin (the image runs Node 22), so a
 * drifted ARG silently brings the download back. Bump both together.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'apps/box/Dockerfile'), 'utf8');

describe('wrangler version pin in the Box image', () => {
  it('the Dockerfile ARG equals the CLI pin for Node 22', () => {
    const arg = /^ARG WRANGLER_VERSION=(\S+)$/m.exec(dockerfile)?.[1] ?? '';
    expect(arg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(arg).toBe(WRANGLER_VERSION_NODE22);
  });

  it('installs into the directory the CLI looks in, through the ARG only', () => {
    expect(dockerfile).toContain(`--prefix "${BAKED_TOOLS_DIR}/wrangler-\${WRANGLER_VERSION}"`);
    expect(dockerfile).toContain('"wrangler@${WRANGLER_VERSION}"');
    // No second, unpinned wrangler install anywhere in the image.
    expect(dockerfile.match(/wrangler@\S*/g)).toEqual(['wrangler@${WRANGLER_VERSION}"']);
  });

  it('the image runs Node 22, the line WRANGLER_VERSION_NODE22 is for', () => {
    expect(dockerfile).toMatch(/^FROM \S+node:22[-\w]*$/m);
  });
});
