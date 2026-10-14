/**
 * Prompt the CLI sends to the user's linked agent (Claude, Codex, …)
 * in a headless one-shot to detect how to start the project's dev
 * server. Same pattern as the AI Insights "summary" prompt — the
 * agent runs locally with the user's auth, has read access to the
 * project, and returns a tiny JSON blob the CLI parses.
 *
 * Kept here (in `@codeam/shared`) so the CLI build inlines the
 * exact string at compile time without runtime fetch from the backend.
 */
export const PREVIEW_DETECT_PROMPT = `
Analyze the project in the current working directory and return how to start
its development server for in-app preview.

Read package.json, Procfile, Dockerfile, docker-compose.yml, manage.py, app.json,
mix.exs, Cargo.toml, go.mod, requirements.txt, pyproject.toml, Gemfile, and any
other framework markers you find at depth <= 2. The app may live in a subfolder
(e.g. teleshop/requirements.txt with nothing runnable at the root) — look there
too.

Return ONLY a JSON object on stdout (no prose, no markdown fences):

{
  "framework": "<name, or 'unsupported'>",
  "cwd": "<folder the dev server runs in, relative to the current directory; '.' for the root>",
  "command": "<executable>",
  "args": ["..."],
  "port": <number>,
  "ready_pattern": "<regex matching the server-ready stdout line>",
  "env": { "HOST": "0.0.0.0" },
  "setup_commands": [{ "cmd": "<executable>", "args": ["..."] }],
  "notes": "<one-line caveat or null>"
}

Rules:
- Pick the script the developer would run locally to see the app (typically "dev", "start", "serve").
- If the app lives in a subfolder, set "cwd" to that folder (e.g. "teleshop"). command,
  args and setup_commands then run INSIDE it: write paths relative to it
  (".venv/bin/python", not "teleshop/.venv/bin/python"), and never wrap the command
  in "cd … &&" or "sh -c" — it is executed directly, without a shell.
- Python: use the project's virtualenv interpreter when one exists
  (".venv/bin/python" with args ["-m","uvicorn","main:app","--host","0.0.0.0","--port","8000"]),
  otherwise "python3".
- Prefer binding to 0.0.0.0 — most frameworks default to localhost which the tunnel cannot reach.
- For Expo: framework="Expo", command="npx", args=["expo","start","--tunnel"], port=8081, notes="Scan QR with Expo Go".
- For PHP (composer.json / index.php): use PHP's built-in server bound to 0.0.0.0 with the
  web root as docroot — command="php", args=["-S","0.0.0.0:8080","-t","public"] (Yii3,
  Symfony, Slim, Mezzio; use the real docroot, e.g. "web" for Yii2, "." for plain PHP),
  port=8080, ready_pattern="Development Server". Laravel: command="php",
  args=["artisan","serve","--host=0.0.0.0","--port=8000"], port=8000,
  ready_pattern="Server running". Do NOT use "composer serve", "symfony serve" or a
  "./yii serve" wrapper — call php directly.
- If no dev server applies (CLI library, lambda, batch script): {"framework":"unsupported","notes":"<reason>"}.

CRITICAL — setup_commands:
- DO NOT include an install command (npm install, pnpm install, yarn install,
  yarn, bun install, composer install) in setup_commands. Pre-flight installers
  run BEFORE setup_commands: composer install whenever composer.json exists and
  vendor/ is missing, and a lockfile-aware Node installer that picks the
  correct package manager from the lockfile present (pnpm-lock.yaml -> pnpm,
  yarn.lock -> yarn, bun.lockb -> bun, else npm). Emitting an install here
  either duplicates that work or, worse,
  uses the WRONG package manager on top of node_modules just populated by the
  pre-flight, which crashes (e.g. npm errors with "Cannot read properties of
  null (reading 'matches')" when run over pnpm's .pnpm/ layout).
- ONLY include setup_commands for genuinely non-install work the project needs
  before its dev server can boot: prisma generate, codegen, prebuild scripts,
  database migrations against a local SQLite, etc.
- Each setup_commands entry MUST be an object {"cmd": "...", "args": ["..."]} —
  e.g. {"cmd": "npx", "args": ["prisma", "generate"]}. NOT a bare string.
- For most projects, setup_commands should be an empty array [].

OUTPUT JSON ONLY. NO MARKDOWN. NO COMMENTARY.
`.trim();
