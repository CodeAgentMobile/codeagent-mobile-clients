import { execFile, spawn } from 'child_process';
import dns, { Resolver } from 'dns/promises';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import which from 'which';
import { log } from '../logger';

const CACHED_BINARY = path.join(os.homedir(), '.codeam', 'bin', 'cloudflared');

/**
 * Block until a Cloudflare Quick Tunnel URL is DNS-resolvable.
 * cloudflared prints its URL the moment its local connector is up,
 * but the public `*.trycloudflare.com` hostname needs a few seconds
 * for DNS to propagate. If the mobile WebView opens the URL during
 * that window it gets NXDOMAIN and caches the negative result —
 * `webview.reload()` does NOT bypass the cache, so a "server IP
 * could not be found" page persists until the user fully tears the
 * preview down and reopens it. Blocking `preview_ready` on DNS
 * resolution gives the WebView a non-poisoned first load.
 *
 * Why `dns.lookup` (getaddrinfo / OS resolver), not c-ares:
 *
 *   Empirical measurement inside a GitHub Codespace, with a tunnel
 *   spawned via `cloudflared tunnel --url ...`:
 *
 *     dns.lookup (getaddrinfo)                  →  ~3 s to resolve
 *     Resolver.resolve4 + system /etc/resolv.conf →  >38 s ENOTFOUND
 *     Resolver.resolve4 + 1.1.1.1 explicit       →  >60 s ENOTFOUND
 *
 *   The OS resolver in modern Linux distros (systemd-resolved) uses a
 *   shared cache hierarchy fed by multiple paths (GHC's internal
 *   resolver in codespaces, fast IPv6 to Google/Cloudflare). c-ares
 *   does UDP queries directly to the configured nameservers and
 *   misses that fast path entirely.
 *
 *   An earlier version of this probe used `Resolver` pointed at
 *   1.1.1.1 + `resolve4` only. That hit BOTH a slow-path issue
 *   (c-ares to 1.1.1.1 doesn't see fresh trycloudflare records for
 *   30-60 s) AND a record-class issue (Quick Tunnels often publish
 *   only AAAA initially, no A). Mobile WebViews ALWAYS use the OS
 *   resolver — using `dns.lookup` here matches their resolution path
 *   so when our probe says "ready" the WebView does too.
 *
 *   Earlier comments warned that getaddrinfo caches NXDOMAIN
 *   aggressively. Measured behavior: the negative cache TTL is short
 *   enough that 1-second polling sees positive results within
 *   3-4 ticks of the tunnel becoming reachable. The hypothesised
 *   cache poisoning does not materialise.
 */
export async function waitForCloudflaredReady(
  url: string,
  timeoutMs = 60_000,
): Promise<void> {
  const hostname = new URL(url).hostname;
  // c-ares fallback in case `dns.lookup` is somehow misconfigured
  // (custom /etc/nsswitch.conf, container with no resolver). Probes
  // BOTH classes — Quick Tunnels often publish AAAA before A. Each
  // tick fires lookup + resolve4 + resolve6 in parallel and
  // accepts whichever lands first.
  const cares = new Resolver();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lookup = dns
      .lookup(hostname, { all: true })
      .then((addrs) => addrs.length > 0, () => false);
    const v4 = cares
      .resolve4(hostname)
      .then((addrs) => addrs.length > 0, () => false);
    const v6 = cares
      .resolve6(hostname)
      .then((addrs) => addrs.length > 0, () => false);
    const results = await Promise.all([lookup, v4, v6]);
    if (results.some((ok) => ok)) return;
    // 1 s tick on purpose — faster polling poisons the OS negative
    // cache and pushes time-to-resolve out by several seconds.
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `DNS for ${hostname} did not resolve within ${timeoutMs}ms (Cloudflare Quick Tunnel registration may have failed).`,
  );
}

interface Options {
  /** Skip the GitHub Releases download. Used in tests + offline pre-flight. */
  skipDownload?: boolean;
}

/** `[year, month, patch]` — cloudflared's calendar version (`2026.10.2`). */
export type CloudflaredVersion = readonly [number, number, number];

/**
 * Builds older than this trust the compromised eMudhra intermediate
 * certificates (Cloudflare advisory, 2026-10-20) and Cloudflare requires
 * connectors to upgrade.
 */
export const MIN_CLOUDFLARED_VERSION: CloudflaredVersion = [2026, 10, 2];
/**
 * macOS builds not installed through Homebrew ship their own trust bundle and
 * needed one more release to drop the eMudhra intermediates.
 */
export const MIN_CLOUDFLARED_VERSION_DARWIN_NON_BREW: CloudflaredVersion = [2026, 10, 3];

const HOMEBREW_PREFIXES = [
  '/opt/homebrew/',
  '/usr/local/Cellar/',
  '/usr/local/Homebrew/',
  '/home/linuxbrew/',
];

/** Parse `cloudflared --version` output (`cloudflared version 2026.10.2 (built …)`). */
export function parseCloudflaredVersion(output: string): CloudflaredVersion | null {
  const m = /cloudflared version (\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `bin` (or its symlink target) lives under a Homebrew prefix. */
export function isHomebrewPath(bin: string): boolean {
  return HOMEBREW_PREFIXES.some((prefix) => bin.startsWith(prefix));
}

export function formatCloudflaredVersion(v: CloudflaredVersion): string {
  return v.join('.');
}

/** The minimum version a binary at `bin` must report on `platform`. */
export function minimumCloudflaredVersion(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): CloudflaredVersion {
  return platform === 'darwin' && !isHomebrewPath(bin)
    ? MIN_CLOUDFLARED_VERSION_DARWIN_NON_BREW
    : MIN_CLOUDFLARED_VERSION;
}

function compareVersions(a: CloudflaredVersion, b: CloudflaredVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * True when `version` meets the minimum for `bin` on `platform`. An unknown
 * (unparseable / unrunnable) version is treated as outdated.
 */
export function meetsMinimumCloudflaredVersion(
  version: CloudflaredVersion | null,
  bin: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!version) return false;
  return compareVersions(version, minimumCloudflaredVersion(bin, platform)) >= 0;
}

// Per-process cache so a preview start doesn't spawn `--version` every time.
// Keyed by path; the cache entry is dropped whenever we replace that file.
const versionCache = new Map<string, Promise<CloudflaredVersion | null>>();
const warnedOutdated = new Set<string>();

/** Test-only: forget cached `--version` results. */
export function _resetCloudflaredVersionCache(): void {
  versionCache.clear();
  warnedOutdated.clear();
}

function readCloudflaredVersion(bin: string): Promise<CloudflaredVersion | null> {
  let cached = versionCache.get(bin);
  if (!cached) {
    cached = new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout, stderr) => {
        resolve(err ? null : parseCloudflaredVersion(`${stdout}\n${stderr}`));
      });
    });
    versionCache.set(bin, cached);
  }
  return cached;
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Whether the binary at `bin` is new enough. A Homebrew-managed binary is
 * usually reached through a `/usr/local/bin` symlink into the Cellar, so the
 * Homebrew rule looks at the symlink target as well as the path itself.
 */
async function checkCloudflaredVersion(
  bin: string,
): Promise<{ ok: boolean; version: CloudflaredVersion | null; min: CloudflaredVersion }> {
  const version = await readCloudflaredVersion(bin);
  const real = await realpathOrSelf(bin);
  const brewBin = isHomebrewPath(bin) ? bin : real;
  return {
    ok: meetsMinimumCloudflaredVersion(version, brewBin),
    version,
    min: minimumCloudflaredVersion(brewBin),
  };
}

function describeVersion(v: CloudflaredVersion | null): string {
  return v ? formatCloudflaredVersion(v) : 'an unknown version';
}

/**
 * Resolve a path to the cloudflared binary. Lookup order:
 *
 *   1. `$PATH` (Homebrew / scoop / system install)
 *   2. The CLI's own cache at `~/.codeam/bin/cloudflared` (from a
 *      previous auto-install on this machine)
 *   3. Download the static binary from cloudflare/cloudflared's
 *      latest GitHub release into the cache and return that path
 *
 * Every candidate must meet {@link minimumCloudflaredVersion}: an outdated
 * PATH binary is skipped (with a warning), an outdated cached binary is
 * deleted and re-downloaded, and a fresh download that is still too old
 * throws.
 *
 * Throws when steps 1–3 all fail (corporate proxy, antivirus
 * quarantine). The error message is what the mobile / landing error
 * card renders verbatim, so it MUST be human-actionable.
 */
export async function resolveCloudflared(opts: Options = {}): Promise<string> {
  let pathBin: string | undefined;
  try {
    pathBin = await which('cloudflared');
  } catch {
    // fallthrough
  }
  if (pathBin) {
    const check = await checkCloudflaredVersion(pathBin);
    if (check.ok) return pathBin;
    if (!warnedOutdated.has(pathBin)) {
      warnedOutdated.add(pathBin);
      log.warn(
        'preview',
        `ignoring ${pathBin} (${describeVersion(check.version)}): previews need cloudflared >= ${formatCloudflaredVersion(check.min)}; upgrade it with \`brew upgrade cloudflared\` or your package manager. Using a CodeAgent-managed copy instead.`,
      );
    }
  }

  try {
    await fs.access(CACHED_BINARY);
    // isExecutableBinary self-heals an earlier bug that wrote the macOS `.tgz`
    // archive straight to this path (spawn ENOEXEC).
    if (
      (await isExecutableBinary(CACHED_BINARY)) &&
      (await checkCloudflaredVersion(CACHED_BINARY)).ok
    ) {
      return CACHED_BINARY;
    }
    // Corrupt or outdated: drop it and re-download the latest release below.
    await fs.rm(CACHED_BINARY, { force: true });
    versionCache.delete(CACHED_BINARY);
  } catch {
    // fallthrough
  }

  if (opts.skipDownload) {
    throw new Error(
      `cloudflared not installed (or older than ${formatCloudflaredVersion(minimumCloudflaredVersion(CACHED_BINARY))}). Install or upgrade via \`brew install cloudflared\` (macOS) or download from https://github.com/cloudflare/cloudflared/releases.`,
    );
  }

  await downloadCloudflared(CACHED_BINARY);
  versionCache.delete(CACHED_BINARY);
  const check = await checkCloudflaredVersion(CACHED_BINARY);
  if (!check.ok) {
    await fs.rm(CACHED_BINARY, { force: true });
    versionCache.delete(CACHED_BINARY);
    throw new Error(
      `Downloaded cloudflared reports ${describeVersion(check.version)}, but previews need cloudflared >= ${formatCloudflaredVersion(check.min)}. Install the latest version manually via \`brew install cloudflared\` (macOS) or from https://github.com/cloudflare/cloudflared/releases.`,
    );
  }
  return CACHED_BINARY;
}

async function downloadCloudflared(target: string): Promise<void> {
  const url = downloadUrlForPlatform();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download cloudflared from ${url}: HTTP ${response.status}. Install manually from https://github.com/cloudflare/cloudflared/releases.`,
    );
  }

  // macOS releases ship a gzipped tarball (`cloudflared-darwin-*.tgz`) whose
  // single entry is the `cloudflared` executable — it MUST be extracted.
  // Writing the .tgz bytes straight to `target` (and chmod +x) produces a
  // non-executable gzip file that fails with `spawn ENOEXEC` — the macOS-only
  // bug this guards. Linux/Windows URLs are the raw binary/.exe, so they stream
  // straight to disk as before.
  if (url.endsWith('.tgz')) {
    const tmp = `${target}.download.tgz`;
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      createWriteStream(tmp),
    );
    try {
      await extractTgz(tmp, path.dirname(target));
      // The tarball's top-level entry is `cloudflared` → it lands at `target`.
      await fs.access(target);
      await fs.chmod(target, 0o755);
    } catch (err) {
      throw new Error(
        `Downloaded the cloudflared archive but could not extract the binary: ${
          (err as Error).message
        }. Install manually via \`brew install cloudflared\`.`,
      );
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return;
  }

  await pipeline(
    response.body as unknown as NodeJS.ReadableStream,
    createWriteStream(target, { mode: 0o755 }),
  );
}

/**
 * True unless the file is actually a gzip archive. A previous version wrote the
 * macOS `cloudflared-darwin-*.tgz` bytes straight to the binary path and
 * chmod +x'd it → `spawn` then failed with ENOEXEC. Detect that corrupt cache
 * by its gzip magic (0x1f 0x8b) so the caller can re-download + extract it.
 */
export async function isExecutableBinary(p: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(p, 'r');
    const buf = Buffer.alloc(2);
    await handle.read(buf, 0, 2, 0);
    return !(buf[0] === 0x1f && buf[1] === 0x8b);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * Extract the `cloudflared` binary from a downloaded macOS `.tgz` into
 * `destDir`. Cloudflare ships macOS builds as a gzipped tarball containing a
 * single `cloudflared` executable; Linux/Windows ship the raw binary. We shell
 * out to the system `tar` (always present on macOS/Linux) rather than pull in a
 * tar dependency just for this one platform's archive format.
 */
export function extractTgz(tgzPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tgzPath, '-C', destDir], { stdio: 'ignore' });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar exited with code ${code} while extracting cloudflared`)),
    );
  });
}

function downloadUrlForPlatform(): string {
  const platform = process.platform;
  const arch = process.arch;
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  if (platform === 'darwin' && arch === 'arm64') return `${base}/cloudflared-darwin-arm64.tgz`;
  if (platform === 'darwin' && arch === 'x64') return `${base}/cloudflared-darwin-amd64.tgz`;
  if (platform === 'linux' && arch === 'x64') return `${base}/cloudflared-linux-amd64`;
  if (platform === 'linux' && arch === 'arm64') return `${base}/cloudflared-linux-arm64`;
  if (platform === 'win32') return `${base}/cloudflared-windows-amd64.exe`;
  throw new Error(
    `cloudflared auto-install not supported on ${platform}/${arch}. Install manually from https://github.com/cloudflare/cloudflared/releases.`,
  );
}

/**
 * Spawn `cloudflared tunnel --url http://localhost:<port>` and resolve
 * with the running child. The caller watches stderr for the
 * `https://*.trycloudflare.com` URL via {@link parseCloudflaredUrl}.
 */
export function spawnCloudflaredTunnel(bin: string, port: number): ReturnType<typeof spawn> {
  return spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Decode a Cloudflare tunnel token (base64 of `{"a":accountTag,"t":tunnelID,
 * "s":tunnelSecret}`) into the credentials-file JSON `cloudflared` expects.
 * Throws if the token isn't the expected shape so the caller can fall back
 * to a quick tunnel.
 */
export function decodeTunnelToken(token: string): {
  AccountTag: string;
  TunnelID: string;
  TunnelSecret: string;
} {
  const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as {
    a?: string;
    t?: string;
    s?: string;
  };
  if (!decoded.a || !decoded.t || !decoded.s) {
    throw new Error('cloudflared token missing accountTag/tunnelID/tunnelSecret');
  }
  return { AccountTag: decoded.a, TunnelID: decoded.t, TunnelSecret: decoded.s };
}

/**
 * Spawn a NAMED tunnel from a backend-provisioned token. The tunnel lives
 * under our own zone (`*.preview.codeagent-mobile.com`), which ISP/security
 * resolvers serve reliably — unlike `*.trycloudflare.com`. The token decodes
 * to a credentials file; we run the tunnel locally-managed with `--url` so
 * the box sets its own ingress (no backend round-trip). The public hostname
 * is fixed (the caller already knows it), but we still gate readiness on the
 * `Registered tunnel connection` stderr line, exactly like the quick tunnel.
 */
export async function spawnNamedTunnel(
  bin: string,
  token: string,
  port: number,
): Promise<ReturnType<typeof spawn>> {
  const creds = decodeTunnelToken(token);
  const credDir = path.join(os.homedir(), '.codeam');
  await fs.mkdir(credDir, { recursive: true });
  const credFile = path.join(credDir, `tunnel-${creds.TunnelID}.json`);
  await fs.writeFile(credFile, JSON.stringify(creds), { mode: 0o600 });
  return spawn(
    bin,
    [
      'tunnel',
      'run',
      '--credentials-file',
      credFile,
      '--url',
      `http://localhost:${port}`,
      creds.TunnelID,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
