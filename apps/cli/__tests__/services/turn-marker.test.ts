import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetTurnMarkerDepth,
  isProcessMidTurn,
  turnMarkerPath,
  watchTurnMarkers,
  withTurnMarker,
} from '../../src/services/turn-marker';

// The host-agent restarts onto an update only when no session is mid-turn;
// this marker is how a session child says so.
let home: string;
// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
const origEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeam-turn-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  __resetTurnMarkerDepth();
});
afterEach(() => {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('turn marker', () => {
  it('exists while a turn runs and is gone after it, even when it throws', async () => {
    const codeam = path.join(home, '.codeam');
    let seen = false;
    await withTurnMarker(async () => {
      seen = isProcessMidTurn(process.pid, codeam);
    });
    expect(seen).toBe(true);
    expect(isProcessMidTurn(process.pid, codeam)).toBe(false);
    await expect(
      withTurnMarker(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(turnMarkerPath(process.pid, codeam))).toBe(false);
  });

  it('overlapping turns keep the marker until the LAST one ends', async () => {
    const codeam = path.join(home, '.codeam');
    let release!: () => void;
    const long = withTurnMarker(() => new Promise<void>((r) => (release = r)));
    await withTurnMarker(async () => undefined);
    expect(isProcessMidTurn(process.pid, codeam)).toBe(true);
    release();
    await long;
    expect(isProcessMidTurn(process.pid, codeam)).toBe(false);
  });

  it('an unknown pid is never mid-turn', () => {
    expect(isProcessMidTurn(undefined)).toBe(false);
  });
});

describe('watchTurnMarkers', () => {
  // The host-agent restarts onto an owed update the moment the last turn ends. The
  // production shape: a turn is ALREADY running when the restart is deferred and the
  // watch armed; what must arrive is the END of that turn.
  it('fires when a running turn ends, and stops after close', async () => {
    const codeam = path.join(home, '.codeam');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let release: () => void = () => undefined;
    const turn = withTurnMarker(() => new Promise<void>((r) => (release = r)));
    let events = 0;
    const close = watchTurnMarkers(() => {
      events++;
    }, codeam);
    // macOS FSEvents drops changes made in the first instants of a new stream.
    await sleep(500);
    events = 0;
    release();
    await turn;
    for (let i = 0; i < 60 && events === 0; i++) await sleep(50);
    expect(events).toBeGreaterThan(0);
    close();
    const afterClose = events;
    await withTurnMarker(async () => undefined);
    await sleep(300);
    expect(events).toBe(afterClose);
  }, 10_000);

  it('a directory it cannot create yields a no-op closer, never a throw', () => {
    const file = path.join(home, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(() => watchTurnMarkers(() => undefined, file)()).not.toThrow();
  });
});
