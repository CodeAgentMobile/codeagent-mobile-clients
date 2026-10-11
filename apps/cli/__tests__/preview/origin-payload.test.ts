import { describe, expect, it } from 'vitest';
import { originPayload } from '../../src/commands/start/handlers';

// The wire tag for who started a preview. `user` stays ABSENT so every
// button-driven event is byte-identical; `agent` and `auto` (the CLI's own
// restore / build-heal restart) are written so the backend never counts or
// refunds them as the user's (codeagent-pe0f).
describe('originPayload', () => {
  it('leaves user / untagged payloads untouched', () => {
    const p = { framework: 'Next.js' };
    expect(originPayload(p, undefined)).toBe(p);
    expect(originPayload(p, 'user')).toBe(p);
    expect(originPayload(undefined, 'user')).toBeUndefined();
  });

  it('tags agent and auto starts on the wire', () => {
    expect(originPayload({ framework: 'Next.js' }, 'agent')).toEqual({
      framework: 'Next.js',
      origin: 'agent',
    });
    expect(originPayload(undefined, 'auto')).toEqual({ origin: 'auto' });
  });
});
