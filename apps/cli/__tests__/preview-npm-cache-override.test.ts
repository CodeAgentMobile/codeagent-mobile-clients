import { describe, expect, it } from 'vitest';
import { npmCacheOverride } from '../src/services/preview/run-setup';

describe('npmCacheOverride — a Box whose npm cache holds root-owned entries (2026-10-31)', () => {
  const owners = (map: Record<string, number>) => (p: string) => (p in map ? map[p] : null);

  it('points npm at ~/.npm when an index entry belongs to another user', () => {
    expect(
      npmCacheOverride(
        { npm_config_cache: '/opt/npm-cache' },
        '/home/box',
        owners({
          '/opt/npm-cache': 1001,
          '/opt/npm-cache/_cacache': 1001,
          '/opt/npm-cache/_cacache/index-v5': 0,
        }),
        1001,
      ),
    ).toEqual({ npm_config_cache: '/home/box/.npm' });
  });

  it('leaves a cache the box owns alone, and does nothing without a configured cache', () => {
    expect(
      npmCacheOverride(
        { npm_config_cache: '/opt/npm-cache' },
        '/home/box',
        owners({ '/opt/npm-cache': 1001, '/opt/npm-cache/_cacache': 1001 }),
        1001,
      ),
    ).toEqual({});
    expect(npmCacheOverride({}, '/home/box', owners({}), 1001)).toEqual({});
  });
});
