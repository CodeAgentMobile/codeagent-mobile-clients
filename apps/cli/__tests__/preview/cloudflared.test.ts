import { execFile } from 'child_process';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import which from 'which';
import { log } from '../../src/services/logger';
import {
  _resetCloudflaredVersionCache,
  homebrewPrefixes,
  isHomebrewPath,
  meetsMinimumCloudflaredVersion,
  minimumCloudflaredVersion,
  parseCloudflaredVersion,
  resolveCloudflared,
  waitForCloudflaredReady,
} from '../../src/services/preview/cloudflared';

const { resolve4Mock, resolve6Mock, setServersMock, lookupMock } = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolve6Mock: vi.fn(),
  setServersMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
  Resolver: function MockResolver() {
    return {
      resolve4: resolve4Mock,
      resolve6: resolve6Mock,
      setServers: setServersMock,
    };
  },
}));

vi.mock('which');
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, createWriteStream: vi.fn() };
});
vi.mock('stream/promises', () => ({ pipeline: vi.fn(async () => undefined) }));
vi.mock('../../src/services/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    default: {
      ...actual,
      access: vi.fn(),
      chmod: vi.fn(),
      mkdir: vi.fn(),
      open: vi.fn(),
      realpath: vi.fn(),
      rename: vi.fn(),
      rm: vi.fn(),
    },
    access: vi.fn(),
    chmod: vi.fn(),
    mkdir: vi.fn(),
    open: vi.fn(),
    realpath: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
  };
});

/**
 * Make `<bin> --version` report `versions[bin]` (a version string, or `null`
 * for a binary that fails to run). Returns the call log.
 */
function mockVersions(versions: Record<string, string | null | (() => string | null)>) {
  vi.mocked(execFile).mockImplementation(((
    bin: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const key = Object.keys(versions).find((k) => bin === k || bin.endsWith(k));
    const raw = key === undefined ? null : versions[key];
    const v = typeof raw === 'function' ? raw() : raw;
    if (v === null) cb(new Error('spawn ENOEXEC'), '', '');
    else cb(null, `cloudflared version ${v} (built 2026-10-20-1200 UTC)\n`, '');
    return {} as never;
  }) as never);
}

const CACHE_SUFFIX = '/.codeam/bin/cloudflared';
const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/**
 * Make `fs.open` (used by `isExecutableBinary`) resolve a handle whose first
 * two bytes are NOT the gzip magic (0x1f 0x8b) — i.e. a healthy cached binary.
 */
function mockHealthyCachedBinary() {
  vi.mocked(fs.open).mockResolvedValue({
    read: vi.fn(async (buf: Buffer) => {
      buf[0] = 0xcf;
      buf[1] = 0xfa;
      return { bytesRead: 2, buffer: buf };
    }),
    close: vi.fn(async () => undefined),
  } as never);
}

describe('parseCloudflaredVersion', () => {
  it('parses the --version line', () => {
    expect(
      parseCloudflaredVersion('cloudflared version 2026.10.2 (built 2026-10-20-1200 UTC)'),
    ).toEqual([2026, 10, 2]);
    expect(parseCloudflaredVersion('cloudflared version 2025.4.0\n')).toEqual([2025, 4, 0]);
  });

  it('returns null for output it cannot read', () => {
    expect(parseCloudflaredVersion('')).toBeNull();
    expect(parseCloudflaredVersion('cloudflared version DEV')).toBeNull();
    expect(parseCloudflaredVersion('zsh: exec format error')).toBeNull();
  });
});

describe('minimum cloudflared version (eMudhra advisory)', () => {
  it('requires 2026.10.2 on linux and windows', () => {
    expect(minimumCloudflaredVersion('/usr/bin/cloudflared', 'linux')).toEqual([2026, 10, 2]);
    expect(minimumCloudflaredVersion('C:\\cf\\cloudflared.exe', 'win32')).toEqual([2026, 10, 2]);
    expect(meetsMinimumCloudflaredVersion([2026, 10, 2], '/usr/bin/cloudflared', 'linux')).toBe(
      true,
    );
    expect(meetsMinimumCloudflaredVersion([2026, 10, 1], '/usr/bin/cloudflared', 'linux')).toBe(
      false,
    );
    expect(meetsMinimumCloudflaredVersion([2026, 9, 9], '/usr/bin/cloudflared', 'linux')).toBe(
      false,
    );
    expect(meetsMinimumCloudflaredVersion([2027, 1, 0], '/usr/bin/cloudflared', 'linux')).toBe(
      true,
    );
  });

  it('requires 2026.10.3 on macOS unless the binary is under a Homebrew prefix', () => {
    const cache = '/Users/me/.codeam/bin/cloudflared';
    expect(meetsMinimumCloudflaredVersion([2026, 10, 2], cache, 'darwin')).toBe(false);
    expect(meetsMinimumCloudflaredVersion([2026, 10, 3], cache, 'darwin')).toBe(true);
    for (const brew of [
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/Cellar/cloudflared/2026.10.2/bin/cloudflared',
      '/usr/local/Homebrew/bin/cloudflared',
      '/home/linuxbrew/.linuxbrew/bin/cloudflared',
    ]) {
      expect(isHomebrewPath(brew)).toBe(true);
      expect(meetsMinimumCloudflaredVersion([2026, 10, 2], brew, 'darwin')).toBe(true);
    }
    expect(isHomebrewPath('/usr/local/bin/cloudflared')).toBe(false);
  });

  it('honours $HOMEBREW_PREFIX and its Cellar', () => {
    const prefixes = homebrewPrefixes({ HOMEBREW_PREFIX: '/custom/brew/' });
    expect(isHomebrewPath('/custom/brew/bin/cloudflared', prefixes)).toBe(true);
    expect(
      isHomebrewPath('/custom/brew/Cellar/cloudflared/2026.10.2/bin/cloudflared', prefixes),
    ).toBe(true);
    expect(isHomebrewPath('/custom/brewery/bin/cloudflared', prefixes)).toBe(false);
    expect(homebrewPrefixes({})).toEqual(homebrewPrefixes({ HOMEBREW_PREFIX: '' }));
  });

  it('treats an unknown version as outdated', () => {
    expect(meetsMinimumCloudflaredVersion(null, '/usr/bin/cloudflared', 'linux')).toBe(false);
  });
});

describe('resolveCloudflared', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetCloudflaredVersionCache();
    setPlatform('linux');
    vi.stubEnv('HOMEBREW_PREFIX', '');
    vi.mocked(fs.realpath).mockImplementation((async (p: string) => p) as never);
  });
  afterEach(() => {
    setPlatform(realPlatform);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the PATH-resident binary when it meets the minimum version', async () => {
    vi.mocked(which).mockResolvedValue('/usr/local/bin/cloudflared' as never);
    mockVersions({ '/usr/local/bin/cloudflared': '2026.10.2' });
    expect(await resolveCloudflared()).toBe('/usr/local/bin/cloudflared');
  });

  it('checks the version once per process, not on every preview', async () => {
    vi.mocked(which).mockResolvedValue('/usr/local/bin/cloudflared' as never);
    mockVersions({ '/usr/local/bin/cloudflared': '2026.10.5' });
    await resolveCloudflared();
    await resolveCloudflared();
    await resolveCloudflared();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('skips an outdated PATH binary, warns, and falls through to the cache', async () => {
    vi.mocked(which).mockResolvedValue('/usr/bin/cloudflared' as never);
    vi.mocked(fs.access).mockResolvedValue(undefined);
    mockHealthyCachedBinary();
    mockVersions({ '/usr/bin/cloudflared': '2025.8.1', [CACHE_SUFFIX]: '2026.10.4' });
    const result = await resolveCloudflared({ skipDownload: true });
    expect(result).toMatch(/[/\\]\.codeam[/\\]bin[/\\]cloudflared$/);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0][1]).toMatch(
      /upgrade cloudflared with your package manager \(e\.g\. `brew upgrade cloudflared`\)/,
    );
    expect(vi.mocked(log.warn).mock.calls[0][1]).toMatch(/2026\.10\.2/);
  });

  it('does not cache a failed --version: a good PATH binary is used once it answers', async () => {
    vi.mocked(which).mockResolvedValue('/usr/bin/cloudflared' as never);
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    let calls = 0;
    mockVersions({ '/usr/bin/cloudflared': () => (++calls === 1 ? null : '2026.10.5') });
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /cloudflared not installed/,
    );
    expect(await resolveCloudflared({ skipDownload: true })).toBe('/usr/bin/cloudflared');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('keeps an outdated cached binary under skipDownload (nothing would replace it)', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    mockHealthyCachedBinary();
    mockVersions({ [CACHE_SUFFIX]: '2026.9.0' });
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /older than 2026\.10\.2/,
    );
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('on macOS, a cached (non-Homebrew) 2026.10.2 is outdated and re-downloaded; 2026.10.3 is kept', async () => {
    setPlatform('darwin');
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    mockHealthyCachedBinary();
    let downloaded = false;
    mockVersions({ [CACHE_SUFFIX]: () => (downloaded ? '2026.10.3' : '2026.10.2') });
    const fetchMock = vi.fn(async () => {
      downloaded = true;
      return { ok: true, status: 200, body: {} };
    });
    vi.stubGlobal('fetch', fetchMock);
    // Stub the `tar` extraction of the downloaded .tgz.
    const cp = await import('child_process');
    vi.mocked(cp.spawn).mockImplementation((() => ({
      on: (ev: string, cb: (code?: number) => void) => {
        if (ev === 'exit') queueMicrotask(() => cb(0));
      },
    })) as never);

    expect(await resolveCloudflared()).toMatch(/[/\\]\.codeam[/\\]bin[/\\]cloudflared$/);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/cloudflared-darwin-.*\.tgz$/));

    // Now at 2026.10.3 (cached for the process): reused, no new download.
    fetchMock.mockClear();
    await resolveCloudflared();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on Windows, caches as cloudflared.exe and migrates the old extensionless cache', async () => {
    setPlatform('win32');
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    const files = new Set<string>(['legacy']);
    const key = (p: string) => (p.endsWith('cloudflared.exe') ? 'exe' : 'legacy');
    vi.mocked(fs.access).mockImplementation((async (p: string) => {
      if (!files.has(key(p))) throw new Error('ENOENT');
    }) as never);
    vi.mocked(fs.rename).mockImplementation((async (from: string, to: string) => {
      files.delete(key(from));
      files.add(key(to));
    }) as never);
    mockHealthyCachedBinary();
    mockVersions({ 'cloudflared.exe': '2026.10.4' });

    const result = await resolveCloudflared({ skipDownload: true });
    expect(result).toMatch(/[/\\]\.codeam[/\\]bin[/\\]cloudflared\.exe$/);
    expect(fs.rename).toHaveBeenCalledWith(
      expect.stringMatching(/cloudflared$/),
      expect.stringMatching(/cloudflared\.exe$/),
    );
    expect(vi.mocked(execFile).mock.calls[0][0]).toMatch(/cloudflared\.exe$/);
  });

  it('on Windows, downloads the .exe to cloudflared.exe', async () => {
    setPlatform('win32');
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    mockVersions({ 'cloudflared.exe': '2026.10.4' });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveCloudflared()).toMatch(/cloudflared\.exe$/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/cloudflared-windows-amd64\.exe$/),
    );
    expect(vi.mocked(createWriteStream).mock.calls[0][0]).toMatch(/cloudflared\.exe$/);
  });

  it('on macOS, honours $HOMEBREW_PREFIX for the 2026.10.2 Homebrew minimum (after realpath)', async () => {
    setPlatform('darwin');
    vi.stubEnv('HOMEBREW_PREFIX', '/custom/brew');
    vi.mocked(which).mockResolvedValue('/usr/local/bin/cloudflared' as never);
    vi.mocked(fs.realpath).mockImplementation((async (p: string) =>
      p === '/usr/local/bin/cloudflared'
        ? '/custom/brew/Cellar/cloudflared/2026.10.2/bin/cloudflared'
        : p) as never);
    mockVersions({ '/usr/local/bin/cloudflared': '2026.10.2' });
    expect(await resolveCloudflared()).toBe('/usr/local/bin/cloudflared');
  });

  it('skips a PATH binary whose version cannot be read', async () => {
    vi.mocked(which).mockResolvedValue('/usr/bin/cloudflared' as never);
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    mockVersions({ '/usr/bin/cloudflared': null });
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /cloudflared not installed/,
    );
  });

  it('on macOS, accepts 2026.10.2 from Homebrew (via the Cellar symlink) but not from elsewhere', async () => {
    setPlatform('darwin');
    vi.mocked(which).mockResolvedValue('/usr/local/bin/cloudflared' as never);
    vi.mocked(fs.realpath).mockImplementation(
      (async () => '/usr/local/Cellar/cloudflared/2026.10.2/bin/cloudflared') as never,
    );
    mockVersions({ '/usr/local/bin/cloudflared': '2026.10.2' });
    expect(await resolveCloudflared()).toBe('/usr/local/bin/cloudflared');

    _resetCloudflaredVersionCache();
    vi.mocked(fs.realpath).mockImplementation((async (p: string) => p) as never);
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /cloudflared not installed/,
    );
  });

  it('deletes an outdated cached binary and re-downloads the latest release', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    mockHealthyCachedBinary();
    let downloaded = false;
    mockVersions({ [CACHE_SUFFIX]: () => (downloaded ? '2026.10.4' : '2026.9.0') });
    const fetchMock = vi.fn(async () => {
      downloaded = true;
      return { ok: true, status: 200, body: {} };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCloudflared();
    expect(result).toMatch(/[/\\]\.codeam[/\\]bin[/\\]cloudflared$/);
    expect(fs.rm).toHaveBeenCalledWith(result, { force: true });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/releases/latest/download/'));
    // Old version read once, re-read after the download (cache invalidated).
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('throws an actionable error when the download is still below the minimum', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    mockVersions({ [CACHE_SUFFIX]: '2026.10.1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    );
    await expect(resolveCloudflared()).rejects.toThrow(
      /reports 2026\.10\.1, but previews need cloudflared >= 2026\.10\.2/,
    );
    expect(fs.rm).toHaveBeenCalled();
  });

  it('falls back to the cached binary when PATH lookup fails (and it is a valid binary)', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    mockHealthyCachedBinary();
    mockVersions({ [CACHE_SUFFIX]: '2026.10.2' });
    const result = await resolveCloudflared({ skipDownload: true });
    // Windows uses backslashes — match either separator so the
    // assertion is OS-agnostic.
    expect(result).toMatch(/[/\\]\.codeam[/\\]bin[/\\]cloudflared$/);
  });

  it('self-heals a gzip-corrupt cached binary — removes it and re-resolves (ENOEXEC regression)', async () => {
    // The pre-fix bug left a `.tgz` (gzip) at the cache path. resolveCloudflared
    // must NOT return it (it would spawn ENOEXEC) — it deletes it and falls
    // through. With skipDownload that surfaces the "not installed" error,
    // proving the corrupt cache was rejected rather than returned.
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.open).mockResolvedValue({
      read: vi.fn(async (buf: Buffer) => {
        buf[0] = 0x1f; // gzip magic → corrupt cache
        buf[1] = 0x8b;
        return { bytesRead: 2, buffer: buf };
      }),
      close: vi.fn(async () => undefined),
    } as never);
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /cloudflared not installed/,
    );
    expect(fs.rm).toHaveBeenCalled();
  });

  it('throws a clear error when binary missing and skipDownload=true', async () => {
    vi.mocked(which).mockRejectedValue(new Error('not found'));
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    await expect(resolveCloudflared({ skipDownload: true })).rejects.toThrow(
      /cloudflared not installed/,
    );
  });
});

describe('waitForCloudflaredReady', () => {
  beforeEach(() => {
    resolve4Mock.mockReset();
    resolve6Mock.mockReset();
    setServersMock.mockReset();
    lookupMock.mockReset();
  });

  const enotfound = Object.assign(new Error('queryA ENOTFOUND'), {
    code: 'ENOTFOUND',
  });
  const enodata = Object.assign(new Error('queryAaaa ENODATA'), {
    code: 'ENODATA',
  });

  it('resolves as soon as dns.lookup (OS resolver) succeeds — the fast path', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '104.16.230.132', family: 4 }]);
    resolve4Mock.mockRejectedValueOnce(enotfound);
    resolve6Mock.mockRejectedValueOnce(enotfound);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith('example.trycloudflare.com', { all: true });
  });

  it('resolves via c-ares A fallback when dns.lookup is broken', async () => {
    lookupMock.mockRejectedValueOnce(enotfound);
    resolve4Mock.mockResolvedValueOnce(['104.16.230.132']);
    resolve6Mock.mockRejectedValueOnce(enodata);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
  });

  it('resolves via c-ares AAAA fallback (Quick Tunnels are often v6-only)', async () => {
    lookupMock.mockRejectedValueOnce(enotfound);
    resolve4Mock.mockRejectedValueOnce(enodata);
    resolve6Mock.mockResolvedValueOnce(['2606:4700::6810:e784']);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 1_000),
    ).resolves.toBeUndefined();
  });

  it('retries past ENOTFOUND across all three probes while DNS propagates', async () => {
    lookupMock
      .mockRejectedValueOnce(enotfound)
      .mockRejectedValueOnce(enotfound)
      .mockResolvedValueOnce([{ address: '104.16.231.132', family: 4 }]);
    resolve4Mock.mockRejectedValue(enotfound);
    resolve6Mock.mockRejectedValue(enotfound);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 10_000),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledTimes(3);
  });

  it('throws when the deadline expires before any probe resolves', async () => {
    lookupMock.mockRejectedValue(enotfound);
    resolve4Mock.mockRejectedValue(enotfound);
    resolve6Mock.mockRejectedValue(enotfound);
    await expect(
      waitForCloudflaredReady('https://example.trycloudflare.com', 200),
    ).rejects.toThrow(/did not resolve within 200ms/);
  });
});
