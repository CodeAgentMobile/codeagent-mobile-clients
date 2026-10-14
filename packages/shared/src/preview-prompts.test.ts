import { describe, expect, it } from 'vitest';
import { PREVIEW_DETECT_PROMPT } from './preview-prompts';

describe('PREVIEW_DETECT_PROMPT', () => {
  it('mentions all required JSON fields', () => {
    for (const field of ['framework', 'command', 'args', 'port', 'ready_pattern']) {
      expect(PREVIEW_DETECT_PROMPT).toContain(`"${field}"`);
    }
  });

  it('mentions the Expo special case', () => {
    // The Expo guidance is rendered as a JSON args literal in the
    // prompt body (`args=["expo","start","--tunnel"]`), not the
    // shell-quoted form.
    expect(PREVIEW_DETECT_PROMPT).toContain('"expo","start","--tunnel"');
    expect(PREVIEW_DETECT_PROMPT).toContain('Expo Go');
  });

  // codeagent-hz3h: a FastAPI app in teleshop/ with its venv there had no way
  // to be expressed — the spawn ran at the root and died ENOENT.
  it('asks for the subfolder an app lives in, with paths relative to it', () => {
    expect(PREVIEW_DETECT_PROMPT).toContain('"cwd"');
    expect(PREVIEW_DETECT_PROMPT).toMatch(/subfolder/);
    expect(PREVIEW_DETECT_PROMPT).toContain('".venv/bin/python", not "teleshop/.venv/bin/python"');
  });

  it('instructs JSON-only output', () => {
    expect(PREVIEW_DETECT_PROMPT).toContain('OUTPUT JSON ONLY');
  });

  it('tells the agent how to serve a PHP project and not to emit composer install', () => {
    expect(PREVIEW_DETECT_PROMPT).toContain('composer.json');
    expect(PREVIEW_DETECT_PROMPT).toContain('"-S","0.0.0.0:8080","-t","public"');
    expect(PREVIEW_DETECT_PROMPT).toContain('Development Server');
    expect(PREVIEW_DETECT_PROMPT).toMatch(/DO NOT include an install command[^]*composer install/);
  });
});
