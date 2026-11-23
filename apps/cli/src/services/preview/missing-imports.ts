import { execFile } from 'child_process';
import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';

/**
 * Packages an Expo app imports but neither declares nor has installed.
 *
 * ⚠️ WHY (2026-11-23, the owner's codespace): the Remix players SUPPLY the platform modules
 * (`expo-clipboard`, `expo-sqlite`, …), so an exported repo's package.json did not declare every
 * module the app imports. Metro then answered 500 "Unable to resolve module expo-clipboard" and
 * the Preview showed a white page. The CLI finds them before Expo starts and installs them with
 * `expo install` (SDK-compatible versions). Path aliases (tsconfig `paths`, babel
 * `module-resolver`), Node built-ins and the app's own server are never installed.
 */

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'server',
  '.git',
  '.expo',
  '.wrangler',
  '.codeam',
  '.beads',
  'dist',
  'build',
  'web-build',
  'ios',
  'android',
]);
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1_000_000;

const IMPORT_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** npm's package-name rules (lowercase, optional scope). */
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** Every import specifier in a source text. */
export function importSpecifiers(source: string): string[] {
  const out = new Set<string>();
  // Drop comments so a commented-out import is not installed.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  for (const re of IMPORT_RES) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** The npm package a bare specifier belongs to (`expo-sqlite/kv-store` → `expo-sqlite`), or null. */
export function packageOf(spec: string, aliases: readonly string[]): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  if (aliases.some((a) => spec === a || spec.startsWith(`${a}/`))) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  return NPM_NAME_RE.test(name) ? name : null;
}

function readJsonLoose(file: string): unknown {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      // tsconfig allows comments and trailing commas.
      return JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
    }
  } catch {
    return null;
  }
}

/** Import prefixes that are aliases, not packages: tsconfig/jsconfig `paths` and babel `alias`. */
export function aliasPrefixes(cwd: string): string[] {
  const out = new Set<string>();
  for (const f of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = readJsonLoose(path.join(cwd, f)) as { compilerOptions?: { paths?: Record<string, unknown> } } | null;
    for (const key of Object.keys(cfg?.compilerOptions?.paths ?? {})) {
      const prefix = key.replace(/\/?\*$/, '');
      if (prefix) out.add(prefix);
    }
  }
  for (const f of ['babel.config.js', 'babel.config.cjs', '.babelrc', '.babelrc.js', 'babel.config.json']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(cwd, f), 'utf8');
    } catch {
      continue;
    }
    for (const block of text.matchAll(/alias\s*["']?\s*:\s*\{([^}]*)\}/g)) {
      for (const k of block[1].matchAll(/["']?([@\w~#$./-]+)["']?\s*:/g)) {
        out.add(k[1].replace(/\/?\*$/, ''));
      }
    }
  }
  return [...out];
}

function sourceFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p);
      } else if (e.isFile() && CODE_EXT.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(p);
      }
    }
  };
  walk(cwd);
  return out;
}

function declared(cwd: string): Set<string> {
  const pkg = readJsonLoose(path.join(cwd, 'package.json')) as Record<string, unknown> | null;
  const names = new Set<string>();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg?.[k];
    if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) names.add(n);
  }
  if (typeof pkg?.name === 'string') names.add(pkg.name);
  return names;
}

/** Packages the app imports that are neither declared in package.json nor installed. */
export function findMissingImports(cwd: string): string[] {
  const aliases = aliasPrefixes(cwd);
  const known = declared(cwd);
  const missing = new Set<string>();
  for (const file of sourceFiles(cwd)) {
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(text)) {
      const name = packageOf(spec, aliases);
      if (!name || known.has(name) || missing.has(name)) continue;
      if (fs.existsSync(path.join(cwd, 'node_modules', name, 'package.json'))) continue;
      missing.add(name);
    }
  }
  return [...missing].sort();
}

/** `expo install <pkgs> -- --legacy-peer-deps` through the project's own expo binary. */
export function expoInstallCommand(cwd: string, pkgs: readonly string[]): { cmd: string; args: string[] } {
  const local = path.join(cwd, 'node_modules', '.bin', 'expo');
  return fs.existsSync(local)
    ? { cmd: local, args: ['install', ...pkgs, '--', '--legacy-peer-deps'] }
    : { cmd: 'npx', args: ['--yes', 'expo', 'install', ...pkgs, '--', '--legacy-peer-deps'] };
}

/** Is `name` a real npm package? (`npm view`, bounded). An unreachable registry counts as no. */
export function npmPackageExists(name: string, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('npm', ['view', name, 'name'], { timeout: timeoutMs }, (err, out) => {
      resolve(!err && out.trim() === name);
    });
  });
}
