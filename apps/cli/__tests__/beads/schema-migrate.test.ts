import { describe, it, expect } from 'vitest';
import { migrateSchema, isSchemaSkew } from '../../src/beads/schema-migrate';
import type { BdRunResult } from '../../src/beads/bd-adapter';

// Output strings below are verbatim from bd 1.3.1 against a bd 1.2.2 DB on the
// shared server (codeam-box:latest, 2026-10-21).
const APPLIED_SHARED: BdRunResult = {
  code: 0,
  stdout: '✓ Schema already at v66\n',
  stderr:
    'Warning: applying 13 pending schema migration(s) to a shared server database (bd migrate schema); co-resident bd clients still on an older binary will refuse this database until they are upgraded (#5920)\n',
};
const CURRENT: BdRunResult = { code: 0, stdout: '✓ Schema already at v66\n', stderr: '' };
const REMOTE_REFUSED: BdRunResult = {
  code: 1,
  stdout: '',
  stderr:
    'refusing to auto-apply 13 pending schema migrations to a remote-backed database (v53 -> v66): migrating clones independently forks the schema (#4259)\n',
};
const APPLIED_FORCED: BdRunResult = {
  code: 0,
  stdout: '✓ Schema already at v66\n',
  stderr:
    'Warning: applying 13 pending schema migration(s) to a remote-backed database (bd migrate --force); only one clone should migrate, then `bd dolt push`\n',
};

function scripted(...results: BdRunResult[]) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]): Promise<BdRunResult> => {
      calls.push(args);
      return results.shift() ?? { code: 0, stdout: '', stderr: '' };
    },
  };
}

describe('migrateSchema', () => {
  it('applies pending migrations on a shared-server DB without --force', async () => {
    const bd = scripted(APPLIED_SHARED);
    expect(await migrateSchema(bd)).toEqual({ status: 'applied', count: 13, forced: false });
    expect(bd.calls).toEqual([['migrate', 'schema']]);
  });

  it('reports an already-current DB', async () => {
    const bd = scripted(CURRENT);
    expect(await migrateSchema(bd)).toEqual({ status: 'current' });
    expect(bd.calls).toHaveLength(1);
  });

  it('retries with --force only when bd refuses a remote-backed DB (#4259)', async () => {
    const bd = scripted(REMOTE_REFUSED, APPLIED_FORCED);
    expect(await migrateSchema(bd)).toEqual({ status: 'applied', count: 13, forced: true });
    expect(bd.calls).toEqual([
      ['migrate', 'schema'],
      ['migrate', 'schema', '--force'],
    ]);
  });

  it('never pushes or bootstraps', async () => {
    const bd = scripted(REMOTE_REFUSED, APPLIED_FORCED);
    await migrateSchema(bd);
    expect(bd.calls.flat()).not.toContain('push');
    expect(bd.calls.flat()).not.toContain('bootstrap');
  });

  it('returns failed (no --force) for any other error, e.g. a missing DB', async () => {
    const bd = scripted({
      code: 1,
      stdout: '',
      stderr: 'Error: failed to open database: database "ghost" not found on Dolt server',
    });
    const out = await migrateSchema(bd);
    expect(out.status).toBe('failed');
    expect(bd.calls).toEqual([['migrate', 'schema']]);
  });
});

describe('isSchemaSkew', () => {
  it('matches the 1146 table-not-found failure', () => {
    expect(
      isSchemaSkew('Error: search count issues: Error 1146 (HY000): table not found: leases'),
    ).toBe(true);
  });
  it('matches the auto-migrate refusal `bd status --json` reports', () => {
    expect(
      isSchemaSkew(
        '"error": "refusing to auto-apply 13 pending schema migrations to a shared server database (v53 -> v66)"',
      ),
    ).toBe(true);
  });
  it('ignores unrelated failures', () => {
    expect(isSchemaSkew('Error: no beads database found')).toBe(false);
    expect(isSchemaSkew('connection refused')).toBe(false);
  });
});
