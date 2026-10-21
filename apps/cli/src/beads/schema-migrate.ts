import type { BdRunResult } from './bd-adapter';
import { log } from '../services/logger';

/**
 * Bring a project DB on the shared Dolt server up to the running bd's schema.
 *
 * Why this exists (2026-10-21 incident, reproduced in `codeam-box:latest`): a
 * DB created by an older bd (1.2.2, schema v53) and opened by a newer one
 * (1.3.1, v66) on the SAME shared server is NOT auto-migrated — in
 * shared-server mode bd refuses the first-mover auto-migrate (#5920), so every
 * query fails `Error 1146: table not found: leases` (and `bd ping` with it).
 * The agent's `bd` and the watcher's snapshot both die, and the provisioner's
 * self-heal mistakes the skew for a missing DB. `bd migrate schema` is bd's
 * explicit, idempotent consent and fixes it in place (issues preserved).
 *
 * Two gates, decided from live runs against bd 1.3.1:
 *   • shared-no-remote (#5920) — plain `bd migrate schema` IS the consent. The
 *     only co-resident clients on a box's server are this image's own bd.
 *   • remote-backed (#4259) — the DB has a Dolt remote (a `bd bootstrap` clone
 *     of `refs/dolt/data`). bd refuses without `--force`, and a NEW bd also
 *     refuses `bd dolt pull` until the local DB is migrated, so "pull the
 *     migrator's schema" is not an option once the image upgraded. We pass
 *     `--force` (the box is the DB's only local writer) and do NOT push: two
 *     clones that each migrated independently were verified to pull/merge each
 *     other's history cleanly, and pushing would be a new outward write to the
 *     user's git remote that buys nothing — every other clone has to migrate
 *     locally anyway. The alternative, `bd bootstrap` re-clone, drops local
 *     unpushed issues and can't replace an existing DB. Side effect, verified:
 *     until this clone's first `bd dolt push` publishes the migrated schema,
 *     its `bd dolt pull` fails "local changes would be stomped by merge: events".
 *
 * bd 1.3.1 ignores `--json` here (plain text either way), so the outcome is
 * read from the text. Strictly non-fatal: callers log and carry on.
 */

export type SchemaMigrateOutcome =
  | { status: 'applied'; count: number; forced: boolean }
  | { status: 'current' }
  | { status: 'failed'; detail: string };

/** The part of `BdAdapter` this needs — lets tests pass a scripted fake. */
export interface BdRunner {
  run(args: string[], runOpts?: { cwd?: string }): Promise<BdRunResult>;
}

/**
 * bd's failure signature when the DB is behind the binary: a missing table
 * from a newer migration (`leases`, …) or the auto-migrate refusal itself
 * (`bd status --json` reports the refusal instead of the 1146).
 */
const SCHEMA_SKEW_RE =
  /Error 1146|table not found|refusing to auto-apply \d+ pending schema migration/i;

export function isSchemaSkew(text: string): boolean {
  return SCHEMA_SKEW_RE.test(text);
}

const APPLIED_RE = /applying (\d+) pending schema migration/i;
const REMOTE_GATE_RE = /remote-backed database/i;

export async function migrateSchema(bd: BdRunner): Promise<SchemaMigrateOutcome> {
  let forced = false;
  let res = await bd.run(['migrate', 'schema']);
  if (res.code !== 0 && REMOTE_GATE_RE.test(res.stderr + res.stdout)) {
    log.info('beads', 'schema migrate refused for a remote-backed DB — migrating with --force');
    forced = true;
    res = await bd.run(['migrate', 'schema', '--force']);
  }
  const text = `${res.stderr}\n${res.stdout}`;
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim().slice(0, 200);
    log.warn('beads', `bd migrate schema failed (code=${res.code}): ${detail}`);
    return { status: 'failed', detail };
  }
  const applied = APPLIED_RE.exec(text);
  if (applied) {
    const count = Number(applied[1]);
    log.info(
      'beads',
      `bd migrate schema applied ${count} migration(s)${forced ? ' (--force)' : ''}`,
    );
    return { status: 'applied', count, forced };
  }
  log.trace('beads', 'bd migrate schema: already current');
  return { status: 'current' };
}
