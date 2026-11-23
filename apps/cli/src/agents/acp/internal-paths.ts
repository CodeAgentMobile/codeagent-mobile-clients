import * as path from 'node:path';
import * as os from 'node:os';

/**
 * CodeAgent platform-internals guard — the AGENT-AGNOSTIC, ACP-provided version
 * of the "don't expose CodeAgent's own runtime files" rule.
 *
 * It runs in the ACP CLIENT (this CLI) — the single component EVERY ACP agent
 * (claude / codex / gemini / cursor / opencode) routes through — so one
 * implementation covers all of them, instead of a Claude-only `settings.json`
 * rule. Enforced at two ACP seams:
 *   1. `session/request_permission` (runner): deny tool calls (bash cat/ls,
 *      writes, edits) whose input references an internal path — even under
 *      codespace auto-approve, since the agent still asks the client first.
 *   2. `fs/read_text_file` + `fs/write_text_file` (client): reject reads/writes
 *      of internal paths the adapter delegates to the client.
 *
 * ⚠️ SCOPE — accidental-disclosure / casual-exploration guardrail (Rafael,
 * 2026-07-28: "show me the home folder" listed `~/.codeam` internals). NOT an
 * absolute boundary: an agent that reads fully in-process (no permission request,
 * no fs delegation) can slip through, and a PTY agent (aider) bypasses ACP
 * entirely. That's acceptable because the REAL secrets are server-side and each
 * user runs in their own per-user container. Audit (codeagent-904y, 2026-10-09):
 * the box holds NO platform-wide secret (no upstream model keys, no JWT secret;
 * the enroll token is single-use and only ever in env). What it does hold is
 * per-user and NOT short-lived — `host-agent.json` hostToken + controlPollSecret
 * (valid until the host is de-enrolled), and per session `pluginAuthToken` +
 * `pollSecret` (HMAC of session+plugin, valid while the session exists), the
 * same two in `mcp-secrets/` plus the loopback preview IPC token. Integration
 * OAuth tokens are NOT on disk (`integrations*.json` is `{id, delivery}` only).
 * Every one of them reaches only the same user's own resources. Do NOT rely on
 * this guard to protect a secret.
 *
 * Applied on MANAGED deploys only (the caller gates on `!isLocalSession()`) — on
 * a user's own local machine `~/.codeam` is the user's own config, not ours.
 */

/**
 * `house-claude` never names a user's file, so any mention of it is internal.
 * `.codeam` is different: it is BOTH our home runtime dir (`~/.codeam`) AND the
 * documented PROJECT override dir (`<repo>/.codeam/preview.json`,
 * `<repo>/.codeam/provision/`). A bare substring match blocked an agent writing
 * its own project's `.codeam/preview.json` (Antigravity, 2026-11-23), so every
 * `.codeam` mention is resolved to a path (against the session cwd) and judged
 * by {@link pathIsInternal}, which is anchored at the HOME dir. We deliberately
 * do NOT match a bare `.beads` here — a project's own `./.beads` is legitimate;
 * the home `~/.beads` is caught by {@link pathIsInternal}.
 */
const ALWAYS_INTERNAL_TOKEN = 'house-claude';

/** Characters that end a path inside a shell command / tool title. */
const PATH_DELIMS = /[\s'"`;|&<>()=,\[\]]/;

/** The path-like token around `text[index]`. */
function tokenAt(text: string, index: number): string {
  let a = index;
  while (a > 0 && !PATH_DELIMS.test(text[a - 1])) a--;
  let b = index;
  while (b < text.length && !PATH_DELIMS.test(text[b])) b++;
  return text.slice(a, b);
}

/** A token as an absolute path: `~`/`$HOME` → home, relative → the session cwd. */
function resolveToken(token: string, homeDir: string, cwd: string): string {
  const home = token.match(/^(?:~|\$HOME|\$\{HOME\})(?=$|[/\\])/);
  if (home) return path.join(homeDir, token.slice(home[0].length));
  return path.resolve(cwd, token);
}

/**
 * ACP ToolKinds whose `rawInput`/`title` carry free-form PROSE ABOUT the work —
 * a plan awaiting approval (`switch_mode`, e.g. Claude's ExitPlanMode with
 * `rawInput.plan` = the whole plan text) or a thought (`think`) — not a path or
 * command the tool will touch. Their text must NEVER be scanned for internal
 * tokens: on 2026-08-19 a plan that merely PRINTED the agent's own cwd
 * (`/home/box/.codeam/house-claude/…`) made the guard silently auto-reject the
 * plan-approval prompt, the agent told the user THE USER rejected it, plan mode
 * wedged for the rest of the session, and a source file was destroyed while the
 * agent probed the broken state. Real file access declared by such a call is
 * still caught via the structured `locations[].path` field.
 */
const PROSE_ONLY_TOOL_KINDS = new Set(['think', 'switch_mode']);

/** True when the tool call's kind marks its input as prose (see above). */
export function isProseOnlyToolKind(kind: string | null | undefined): boolean {
  return kind != null && PROSE_ONLY_TOOL_KINDS.has(kind);
}

/**
 * True if arbitrary text (bash command, tool title, a tool-input string)
 * references an internal path. Each `.codeam` occurrence is resolved to the
 * path it sits in — `~/…` and `$HOME/…` against the home dir, a relative one
 * against the session cwd — so `cat ~/.codeam/host-agent.json` is internal and
 * `.codeam/preview.json` in a project is not. The per-deploy workspace at
 * `~/.codeam/self-hosted/<deployId>/` is the USER's cloned repo (⚠️ Rafael,
 * 2026-08-05: every git commit/edit there was denied in MANUAL mode); it is
 * exempted by {@link pathIsInternal}.
 */
export function textReferencesInternal(
  text: string | null | undefined,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): boolean {
  if (!text) return false;
  if (text.includes(ALWAYS_INTERNAL_TOKEN)) return true;
  for (let i = text.indexOf('.codeam'); i !== -1; i = text.indexOf('.codeam', i + 1)) {
    if (pathIsInternal(resolveToken(tokenAt(text, i), homeDir, cwd), homeDir, cwd)) return true;
  }
  return false;
}

/** Every string inside a tool's `rawInput`, so paths are scanned as written (not JSON-escaped). */
function stringsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out, depth + 1);
  return out;
}

/**
 * The project files under `<cwd>/.codeam/` the docs tell an agent (and a team)
 * to write: the Preview override and the generated service compose. Only these
 * matter when the repo IS the home dir (`<cwd>/.codeam` === `~/.codeam`);
 * anywhere else a project's `.codeam/` is outside `~/.codeam` anyway.
 */
function isProjectOverride(abs: string, cwd: string): boolean {
  const dir = path.join(path.resolve(cwd), '.codeam');
  const provision = path.join(dir, 'provision');
  return (
    abs === path.join(dir, 'preview.json') ||
    abs === provision ||
    abs.startsWith(provision + path.sep)
  );
}

/**
 * Precise path check for the fs read/write seam: within `~/.codeam`,
 * `~/.beads`, `~/.codeam-host.log`, or any `house-claude` directory. A
 * relative path resolves against the session cwd; the project's own
 * `.codeam/preview.json` / `.codeam/provision/` never count, even in a repo
 * cloned AT the home dir.
 */
export function pathIsInternal(
  p: string | null | undefined,
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): boolean {
  if (!p) return false;
  const abs = path.resolve(cwd, p);
  const home = path.resolve(homeDir);
  const within = (root: string) => abs === root || abs.startsWith(root + path.sep);
  // The user's cloned project lives under ~/.codeam/self-hosted/<deployId>/ — it
  // is NOT an internal (see textReferencesInternal). Must be checked BEFORE the
  // ~/.codeam catch-all below, which would otherwise swallow the whole workspace.
  if (within(path.join(home, '.codeam', 'self-hosted'))) return false;
  if (isProjectOverride(abs, cwd)) return false;
  return (
    within(path.join(home, '.codeam')) ||
    within(path.join(home, '.beads')) ||
    abs === path.join(home, '.codeam-host.log') ||
    abs.includes(`${path.sep}house-claude${path.sep}`) ||
    abs.endsWith(`${path.sep}house-claude`)
  );
}

/**
 * Inspect an ACP permission request's tool call for a reference to an internal
 * path. Checks the structured `locations[].path` field first (real paths, any
 * kind), then — ONLY for tool kinds that actually operate on paths/commands
 * (read/edit/delete/move/search/execute/fetch/other) — serializes `rawInput`
 * (the bash command / file path / glob) plus the human `title` and matches the
 * internal tokens. Prose-only kinds ({@link isProseOnlyToolKind}) are exempt
 * from the free-text scan: an incidental internal-path MENTION inside plan text
 * is not a file access (the 2026-08-19 ExitPlanMode silent-rejection P0).
 */
export function toolCallReferencesInternal(
  call: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
    locations?: ReadonlyArray<{ path: string }> | null;
  },
  homeDir: string = os.homedir(),
  cwd: string = process.cwd(),
): boolean {
  // Structured path field — authoritative for EVERY kind, prose ones included.
  if (call.locations?.some((l) => pathIsInternal(l.path, homeDir, cwd))) return true;
  // Free-text scan only for kinds whose input IS a path/command.
  if (isProseOnlyToolKind(call.kind)) return false;
  if (textReferencesInternal(call.title, homeDir, cwd)) return true;
  return stringsIn(call.rawInput).some((t) => textReferencesInternal(t, homeDir, cwd));
}

/**
 * The REAL permission decision the ACP runner's `onRequestPermission` uses: given
 * a permission request, return the ACP outcome that DENIES it when it targets an
 * internal path (pick the broadest `reject_*` option; if the agent offers none,
 * `cancelled` aborts the tool), or `null` when the request is fine (the caller
 * then proceeds to auto-approve / interactive). Pure + exported so the guard's
 * decision is tested exactly as the handler runs it.
 */
export function internalPathPermissionOutcome(
  request: {
    toolCall: {
      title?: string | null;
      kind?: string | null;
      rawInput?: unknown;
      locations?: ReadonlyArray<{ path: string }> | null;
    };
    options: ReadonlyArray<{ optionId: string; kind: string }>;
  },
  homeDir?: string,
  cwd?: string,
):
  | { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }
  | null {
  if (!toolCallReferencesInternal(request.toolCall, homeDir, cwd)) return null;
  // Prefer reject_ONCE: the guard re-evaluates every call anyway, and a
  // `reject_always` permanently poisons the tool for the whole session (the
  // 2026-08-19 plan-mode wedge). One blocked call must never disable a tool.
  const reject =
    request.options.find((o) => o.kind === 'reject_once') ??
    request.options.find((o) => o.kind === 'reject_always');
  if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

/** User-facing reason surfaced to the agent when a call is blocked. */
export const INTERNAL_BLOCK_REASON =
  "This path is a CodeAgent platform internal (CodeAgent's own runtime plumbing, " +
  "not part of the user's project) and is off-limits. Continue with the user's own project files.";
