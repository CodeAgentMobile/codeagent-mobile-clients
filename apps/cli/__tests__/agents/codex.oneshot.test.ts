import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/spawn-and-capture', () => ({
  spawnAndCapture: vi.fn(),
}));

import { spawnAndCapture, type SpawnAndCaptureOpts } from '../../src/services/spawn-and-capture';
import { CodexRuntimeStrategy, _codexOneShotSeam } from '../../src/agents/codex/runtime';
import { LinuxOsStrategy } from '../../src/os';

const RACE_STDERR =
  'Error: failed to initialize sqlite state runtime under /home/box/.codex: ' +
  'failed to initialize state runtime at /home/box/.codex\n';

class FakeOs extends LinuxOsStrategy {
  override findInPath(): string | null {
    return '/usr/local/bin/codex';
  }
}

/** A `codex exec` that writes `stderr` and resolves with `result`. */
function execResult(result: string | null, stderr = '') {
  return async (_cmd: string, _args: ReadonlyArray<string>, opts?: SpawnAndCaptureOpts) => {
    if (stderr) opts?.onStderr?.(stderr);
    return result;
  };
}

describe('CodexRuntimeStrategy.generateOneShot — first-run ~/.codex SQLite race', () => {
  const realSleep = _codexOneShotSeam.sleep;
  beforeEach(() => {
    _codexOneShotSeam.sleep = async () => undefined;
    vi.mocked(spawnAndCapture).mockReset();
  });
  afterEach(() => {
    _codexOneShotSeam.sleep = realSleep;
  });

  it('retries once when codex exec lost the state-DB race, and returns the retry output', async () => {
    const spawn = vi.mocked(spawnAndCapture);
    spawn.mockImplementationOnce(execResult(null, RACE_STDERR));
    spawn.mockImplementationOnce(execResult('{"framework":"next"}'));
    const onStderr = vi.fn();

    const out = await new CodexRuntimeStrategy(new FakeOs()).generateOneShot('detect', {
      onStderr,
    });

    expect(out).toBe('{"framework":"next"}');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual(['exec', '--skip-git-repo-check', 'detect']);
    // The caller's stderr hook still sees the failed attempt (debug logging).
    expect(onStderr).toHaveBeenCalledWith(RACE_STDERR);
  });

  it('does NOT retry any other failure', async () => {
    const spawn = vi.mocked(spawnAndCapture);
    spawn.mockImplementationOnce(execResult(null, 'Error: Not logged in\n'));

    const out = await new CodexRuntimeStrategy(new FakeOs()).generateOneShot('detect');

    expect(out).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retries at most once', async () => {
    const spawn = vi.mocked(spawnAndCapture);
    spawn.mockImplementation(execResult(null, RACE_STDERR));

    const out = await new CodexRuntimeStrategy(new FakeOs()).generateOneShot('detect');

    expect(out).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('CodexRuntimeStrategy.generateOneShot — outside a git repo', () => {
  beforeEach(() => vi.mocked(spawnAndCapture).mockReset());

  // `codex exec` without the flag exits 1 with "Not inside a trusted directory
  // and --skip-git-repo-check was not specified." in a non-git folder, so a
  // local session there got `no_output` on every Preview detect.
  it('passes --skip-git-repo-check before the prompt', async () => {
    const spawn = vi.mocked(spawnAndCapture);
    spawn.mockImplementationOnce(execResult('{"framework":"static"}'));

    await new CodexRuntimeStrategy(new FakeOs()).generateOneShot('detect');

    const args = spawn.mock.calls[0][1];
    expect(args[0]).toBe('exec');
    expect(args).toContain('--skip-git-repo-check');
    expect(args.indexOf('--skip-git-repo-check')).toBeLessThan(args.indexOf('detect'));
  });
});
