/**
 * Remix context for the agent (owner 2026-11-24, Pasito): a repo exported from CodeAgent Remix
 * (a root `remix.json`) goes live on every push to its default branch — or is refused. An agent
 * with no Remix knowledge pushed an undeclared host, then 2.3 MB of base64 audio in code, and never
 * heard either refusal. Two pieces ride the squad-context block of a turn (context, never words in
 * the user's bubble), and nothing is ever written into the user's repo:
 *
 *  1. **The contract** — once per (session, agent), when the cwd has a root `remix.json`. Its text
 *     is api-v2's (`GET /api/remix/agent-contract?kind=&server=`, the same `AGENTS.md` every export
 *     now commits; api-v2 `remix-agent-contract.ts` is the single source), fetched once per process
 *     and cached on disk for offline starts.
 *  2. **A refused push** — the backend relays `remix_push_result` to the sessions on that repo
 *     (api-v2 `remix-push-status.ts`); a failure is QUEUED and read at the start of the agent's
 *     NEXT turn. It never starts or interrupts a turn, a sha is noted at most once, and a later
 *     `live` for the app drops a note still waiting.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveApiBaseUrl } from '@codeam/shared';

export const REMIX_PUSH_RESULT_COMMAND = 'remix_push_result';

type Kind = 'WEB' | 'WEB_DATA' | 'MOBILE';
const KINDS: readonly Kind[] = ['WEB', 'WEB_DATA', 'MOBILE'];

export interface RemixProject {
  kind: Kind;
  server: boolean;
}

/** The cwd's root `remix.json`, or null when this is not a Remix project. */
export function readRemixProject(cwd: string): RemixProject | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(cwd, 'remix.json'), 'utf8')) as {
      kind?: unknown;
      server?: unknown;
    };
    if (!KINDS.includes(v.kind as Kind)) return null;
    return { kind: v.kind as Kind, server: typeof v.server === 'object' && v.server !== null };
  } catch {
    return null;
  }
}

export interface RemixContextDeps {
  fetch: typeof fetch;
  apiBase: () => string;
  cacheDir: () => string;
  timeoutMs: number;
}

const defaultDeps: RemixContextDeps = {
  fetch: (...a) => fetch(...a),
  apiBase: resolveApiBaseUrl,
  cacheDir: () => path.join(os.homedir(), '.codeam', 'remix-contract'),
  timeoutMs: 4000,
};

const contracts = new Map<string, Promise<string | null>>();
const given = new Set<string>();
/** appId → the note waiting for the next turn (one per app: a newer failure replaces it). */
const pending = new Map<string, { sha: string; text: string }>();
/** `appId:sha` already noted (or cleared by `live`): a redelivery never repeats it. */
const noted = new Set<string>();

const MAX_PROBLEMS = 20;
const MAX_NOTE_CHARS = 6000;

function cacheFile(deps: RemixContextDeps, key: string): string {
  return path.join(deps.cacheDir(), `${key}.md`);
}

async function loadContract(p: RemixProject, deps: RemixContextDeps): Promise<string | null> {
  const key = `${p.kind}-${p.server ? 'server' : 'static'}`;
  const url = `${deps.apiBase().replace(/\/+$/, '')}/api/remix/agent-contract?kind=${p.kind}&server=${p.server ? 1 : 0}`;
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.startsWith('# ')) {
        try {
          fs.mkdirSync(deps.cacheDir(), { recursive: true });
          fs.writeFileSync(cacheFile(deps, key), text);
        } catch {
          /* the cache is a convenience */
        }
        return text;
      }
    }
  } catch {
    /* offline / slow: the cached copy below */
  }
  try {
    return fs.readFileSync(cacheFile(deps, key), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The contract for this project, fetched once per process (concurrent callers share it). */
export function remixContract(p: RemixProject, deps: RemixContextDeps = defaultDeps): Promise<string | null> {
  const key = `${p.kind}-${p.server}`;
  let got = contracts.get(key);
  if (!got) {
    got = loadContract(p, deps);
    contracts.set(key, got);
  }
  return got;
}

/** Warm the contract at session start, so the first turn never waits on the network. */
export function prefetchRemixContract(cwd: string = process.cwd(), deps: RemixContextDeps = defaultDeps): void {
  const p = readRemixProject(cwd);
  if (p) void remixContract(p, deps);
}

export const REMIX_CONTRACT_HEADER =
  '[Remix project] This repo is a CodeAgent Remix app (root remix.json): every push to its default branch goes live on Remix, or is refused. Follow this contract for every change you make:';

export interface RemixPushResult {
  appId: string;
  title?: string;
  repo?: string;
  sha: string;
  subject?: string;
  state: 'failed' | 'live';
  stage?: string;
  reason?: string;
  problems?: string[];
  version?: number;
}

function parsePushResult(v: unknown): RemixPushResult | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = v as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
  if (!str(d.appId) || !str(d.sha) || (d.state !== 'failed' && d.state !== 'live')) return null;
  return {
    appId: d.appId,
    sha: d.sha,
    state: d.state,
    ...(str(d.title) ? { title: d.title } : {}),
    ...(str(d.repo) ? { repo: d.repo } : {}),
    ...(str(d.subject) ? { subject: d.subject } : {}),
    ...(str(d.stage) ? { stage: d.stage } : {}),
    ...(str(d.reason) ? { reason: d.reason } : {}),
    ...(Array.isArray(d.problems)
      ? { problems: d.problems.filter(str).slice(0, MAX_PROBLEMS) }
      : {}),
  };
}

/** The note the agent reads for a refused push. */
export function pushFailureNote(r: RemixPushResult): string {
  const commit = [r.sha.slice(0, 7), r.subject ? `"${r.subject}"` : null].filter(Boolean).join(' ');
  const lines = [
    `[Remix push refused] Your push ${commit}${r.repo ? ` to ${r.repo}` : ''} did NOT go live on Remix${r.title ? ` (${r.title})` : ''}: the live app stays on its previous version.${r.stage ? ` It stopped at: ${r.stage}.` : ''}`,
  ];
  const problems = r.problems && r.problems.length > 0 ? r.problems : r.reason ? [r.reason] : [];
  if (problems.length > 0) {
    lines.push('Fix these, then commit and push again:');
    for (const p of problems) lines.push(`- ${p}`);
  }
  lines.push(
    "Tell the user in one line that the last push was refused and that you're fixing it (or ask first if the fix changes what they asked for).",
  );
  return lines.join('\n').slice(0, MAX_NOTE_CHARS);
}

/**
 * The `remix_push_result` command: queue a failure for the next turn (once per sha), or drop a
 * waiting one when the app went live. Never prompts the agent.
 */
export function noteRemixPushResult(payload: unknown): 'queued' | 'cleared' | 'ignored' {
  const r = parsePushResult(payload);
  if (!r) return 'ignored';
  const id = `${r.appId}:${r.sha}`;
  if (r.state === 'live') {
    noted.add(id);
    return pending.delete(r.appId) ? 'cleared' : 'ignored';
  }
  if (noted.has(id)) return 'ignored';
  noted.add(id);
  pending.set(r.appId, { sha: r.sha, text: pushFailureNote(r) });
  return 'queued';
}

/**
 * The Remix pieces of THIS turn: the contract (first turn of each agent in this session, when the
 * cwd is a Remix project) and every queued push note (consumed). `[]` for any other repo.
 */
export async function remixContextForTurn(
  sessionId: string,
  agent: string,
  cwd: string = process.cwd(),
  deps: RemixContextDeps = defaultDeps,
): Promise<string[]> {
  const pieces: string[] = [];
  const project = readRemixProject(cwd);
  const key = `${sessionId}:${agent}`;
  if (project && !given.has(key)) {
    const contract = await remixContract(project, deps);
    if (contract) {
      given.add(key);
      pieces.push(`${REMIX_CONTRACT_HEADER}\n\n${contract}`);
    }
  }
  for (const [appId, note] of pending) {
    pieces.push(note.text);
    pending.delete(appId);
  }
  return pieces;
}

/** Test seam. */
export function _resetRemixContext(): void {
  contracts.clear();
  given.clear();
  pending.clear();
  noted.clear();
}
