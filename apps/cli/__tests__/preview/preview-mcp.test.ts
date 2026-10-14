import { describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_IPC_TOKEN_ENV,
  PREVIEW_IPC_URL_ENV,
  PREVIEW_MCP_SERVER_NAME,
  PREVIEW_TOOLS,
  previewMcpServer,
  runPreviewTool,
} from '../../src/commands/preview-mcp';
import { loadMcpSecrets } from '../../src/integrations/mcp-secrets';

describe('preview MCP server entry', () => {
  it('is absent when the bridge never bound', () => {
    expect(previewMcpServer(null)).toBeNull();
  });

  // codeagent-5bew: the claude ACP adapter copies the MCP env onto the agent's
  // argv, so the bridge token must not be in the env at all — only the path of
  // the owner-only secrets file the shim reads at startup.
  it('keeps the bridge token out of argv AND env; the shim resolves it from the secrets file', () => {
    const entry = previewMcpServer({ url: 'http://127.0.0.1:5555', token: 'secret-token' })!;
    expect(entry.name).toBe(PREVIEW_MCP_SERVER_NAME);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([process.argv[1], 'preview-mcp']);
    expect(JSON.stringify(entry)).not.toContain('secret-token');
    const env: NodeJS.ProcessEnv = Object.fromEntries(entry.env.map((e) => [e.name, e.value]));
    expect(env[PREVIEW_IPC_URL_ENV]).toBe('http://127.0.0.1:5555');
    loadMcpSecrets(env);
    expect(env[PREVIEW_IPC_TOKEN_ENV]).toBe('secret-token');
  });

  it('exposes exactly the five preview tools', () => {
    expect(PREVIEW_TOOLS.map((t) => t.name)).toEqual([
      'start_preview',
      'preview_status',
      'highlight_element',
      'clear_highlights',
      'stop_preview',
    ]);
  });
});

describe('runPreviewTool', () => {
  it('start_preview → POST /preview/start and a sentence with the URL', async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'running',
      url: 'https://x.preview.codeagent-mobile.com',
      framework: 'next',
      inspector: true,
    });
    const r = await runPreviewTool('start_preview', {}, call);
    expect(call).toHaveBeenCalledWith('/preview/start', 'POST', {}, expect.any(Number));
    expect(r.isError).toBe(false);
    expect(r.text).toContain('https://x.preview.codeagent-mobile.com');
    expect(r.text).toContain('highlight_element');
  });

  it('a pipeline error comes back as a tool error with its stage', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'error', stage: 'spawn', message: 'EADDRINUSE' });
    const r = await runPreviewTool('start_preview', {}, call);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Preview failed at spawn: EADDRINUSE');
    // codeagent-pe0f: the agent once shared a link for a failed spawn.
    expect(r.text).toMatch(/NOT running.*do not give the user a preview link/);
    expect(r.text).not.toMatch(/https?:\/\//);
  });

  it('a dev server that could not even be spawned is NOT running and has no link (codeagent-hz3h)', async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'error',
      stage: 'spawn',
      message: 'Couldn\'t start the dev server: ".venv/bin/python" was not found in the project root.',
    });
    const r = await runPreviewTool('start_preview', { command: '.venv/bin/python', port: 8000 }, call);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('was not found in the project root');
    expect(r.text).toMatch(/NOT running.*do not give the user a preview link/);
    expect(r.text).not.toMatch(/https?:\/\/|localhost/);
  });

  it("a failed start shows the agent the dev server's output and invites a fixed retry", async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'error',
      stage: 'spawn',
      message: 'The dev server exited (code 1) before it was ready. It may need a database or other services.',
      output: 'ArgError: unknown or unexpected option: --port',
    });
    const r = await runPreviewTool('start_preview', { command: 'npx', args: ['serve', '--port', '5173'], port: 5173 }, call);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('other services. The preview is NOT running');
    expect(r.text).not.toContain('..');
    expect(r.text).toContain('unknown or unexpected option: --port');
    expect(r.text).toMatch(/call start_preview again with the fixed command/);
  });

  it('start_preview accepts a cwd and tells the agent a localhost link never opens on the phone', () => {
    const tool = PREVIEW_TOOLS.find((t) => t.name === 'start_preview');
    const props = (tool?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('cwd');
    expect(tool?.description).toMatch(/localhost/);
  });

  it('"still starting" tells the agent there is no link yet', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'starting', message: 'Still coming up.' });
    const r = await runPreviewTool('start_preview', {}, call);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Still coming up.');
    expect(r.text).toMatch(/no link to give the user/);
  });

  it('clear_highlights posts {clear:true} to the highlight route', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, message: 'Cleared' });
    const r = await runPreviewTool('clear_highlights', {}, call);
    expect(call).toHaveBeenCalledWith('/preview/highlight', 'POST', { clear: true }, expect.any(Number));
    expect(r.isError).toBe(false);
  });

  it('a refused highlight is a tool error', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, message: 'No preview is running' });
    const r = await runPreviewTool('highlight_element', { selector: '#a' }, call);
    expect(r).toEqual({ text: 'No preview is running', isError: true });
  });

  it('an unknown tool is an error', async () => {
    const r = await runPreviewTool('nope', {}, vi.fn());
    expect(r.isError).toBe(true);
  });
});
