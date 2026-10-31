/**
 * Preview wire types (PreviewDetection / PreviewStatus / EnvVar).
 *
 * CANONICAL WIRE OWNER: this file (`@codeam/shared`) owns the wire
 * protocol, per the cross-repo rule. The backend repo keeps hand-synced
 * MIRRORS (`codeagent-mobile/packages/shared/src/types/preview.ts` for
 * mobile/landing, `codeagent-mobile/apps/api-v2/src/common/types/preview.ts`
 * for the backend); a drift-check script at
 * `codeagent-mobile/scripts/check-shared-drift` compares them.
 */
export interface PreviewDetection {
  framework: string;
  command: string;
  args: string[];
  port: number;
  ready_pattern: string;
  env?: Record<string, string>;
  setup_commands?: Array<{ cmd: string; args: string[] }>;
  notes?: string;
  /**
   * Project-relative directory the dev server (and `setup_commands`, and the
   * Node deps pre-flight) runs in — for an app that lives in a subfolder of
   * the workspace (`teleshop/` with its own `.venv`). Absent or `'.'` = the
   * workspace root, the behaviour before this field existed. `command` paths
   * like `.venv/bin/python` resolve against it. The CLI refuses a value that
   * escapes the workspace or doesn't exist. Additive: older CLIs ignore it,
   * and the apps carry it through untouched (the confirm sheet spreads the
   * detection it was given).
   */
  cwd?: string;
  /**
   * Every runnable dev-style script the CLI found in the repo (root + each
   * workspace app), so the confirm sheet can offer them in an autocomplete
   * next to the agent's pick. Additive: older clients ignore it, and the
   * CLI never writes it to `.codeam/preview.json`.
   */
  candidates?: PreviewScriptCandidate[];
}

/**
 * One runnable script, already shaped as a detection the Preview start can
 * use as-is (owner request 2026-09-25: pick any script, e.g. the Expo app of
 * a monorepo, not only the one the agent chose).
 */
export interface PreviewScriptCandidate {
  /** `@dgi/mobile-empresas`, or the root package name. */
  app: string;
  /** Repo-relative dir of the owning package.json ('.' for the root). */
  appDir: string;
  /** The package.json script name (`start`, `dev:empresas`). */
  script: string;
  /** The script body, for display (`expo start`). */
  body: string;
  /** Framework inferred from the owning package's dependencies. */
  framework: string;
  command: string;
  args: string[];
  port: number;
  ready_pattern: string;
}

export type PreviewState =
  | 'idle'
  | 'detection_pending'
  | 'detection_ready'
  | 'starting'
  | 'running'
  | 'error';

export type PreviewErrorStage =
  | 'detection'
  | 'spawn'
  | 'tunnel'
  | 'ready_timeout'
  | 'unsupported';

/**
 * Machine-readable code on a `preview_error`, for errors the apps route to a
 * specific action instead of "Try again". `CREDITS_EXHAUSTED` = the managed
 * agent's detect one-shot was refused by our agent-proxy with a 402 (prepaid
 * wallet at 0) — the apps open top-up; a retry would hit the same 402.
 * Additive: older CLIs omit it.
 */
export type PreviewErrorCode = 'CREDITS_EXHAUSTED';

/**
 * WHY a `stage: 'detection'` / `'unsupported'` preview_error happened —
 * telemetry only (`preview_lifecycle.error_reason`), never user copy, never
 * the agent's raw output. Each value has a different fix, which is the point:
 * five unexplained detection failures in a row (codeagent-qrk1) could not be
 * told apart.
 */
export type PreviewErrorReason =
  | 'empty_project'
  | 'no_oneshot'
  | 'timeout'
  | 'no_output'
  | 'no_json'
  | 'missing_fields'
  | 'provider_credits'
  | 'credits_exhausted'
  | 'unsupported';

/**
 * Un servicio que el proyecto necesita y que NO pudimos levantarle.
 *
 * `envVar` es la variable que el usuario tendria que rellenar para apuntar a
 * uno propio (`DATABASE_URL`, `REDIS_URL`, …). Es el ultimo recurso: primero
 * se intenta docker compose, luego una compose generada, y para Postgres
 * incluso un motor embebido — esto solo viaja cuando todo eso fallo.
 */
export interface MissingService {
  /** Nombre del motor, para decirlo con palabras: `postgres`, `redis`, … */
  service: string;
  /** La variable de entorno que lo resolveria. */
  envVar: string;
}

/**
 * Who started a preview. `agent` = the session's agent called the
 * `start_preview` MCP tool: the app skips the confirm sheet (the agent already
 * chose), shows the "Initializing Preview…" card in the chat and switches to
 * the preview plane once it is ready. `auto` = the CLI brought it back by
 * itself (the restore after a restart/wake, a build-heal restart) — never a
 * tap, so the backend must not count it, or refund it, as the user's. Absent =
 * `user` (the Preview button).
 */
export type PreviewOrigin = 'user' | 'agent' | 'auto';

/**
 * `preview_agent_highlight` — the agent pointing at an element of the running
 * preview. `clear: true` removes every agent mark; otherwise `selector` is a
 * CSS selector the inspector client resolves inside the page.
 */
export interface PreviewAgentHighlight {
  selector?: string;
  label?: string;
  clear?: boolean;
}

export interface PreviewStatus {
  state: PreviewState;
  /** Who started it — lets a reconnecting client keep the agent-launch UI. */
  origin?: PreviewOrigin;
  url?: string;
  /**
   * Expo only (codeam-cli ≥ 2.76.42): `url` is the WEB preview served by Metro (react-native-web)
   * and this is the `exps://` link Expo Go opens for the same server. An older CLI sends the
   * `exps://` link AS `url` and no `expoGoUrl` — the apps keep showing the QR alone for it.
   */
  expoGoUrl?: string;
  framework?: string;
  detection?: PreviewDetection;
  error?: { stage: PreviewErrorStage; message: string; code?: PreviewErrorCode };
  /**
   * Servicios que el proyecto pide y no estan sirviendo.
   *
   * Viaja con el error para que la UI pueda ofrecer algo ACCIONABLE en vez de
   * un fallo mudo: la CLI ya sabia que le faltaba una base de datos y cual era
   * su variable, pero ese dato se tiraba a la basura en `start.ts` y el usuario
   * solo veia morir el dev server.
   */
  missingServices?: MissingService[];
}

/**
 * One environment variable as edited from the app and written to the
 * project `.env`. The wire shape for `env_read` (returns EnvVar[]) and
 * `env_write` (accepts EnvVar[]).
 */
export interface EnvVar {
  key: string;
  value: string;
}
