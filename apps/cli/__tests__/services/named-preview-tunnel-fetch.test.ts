import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchNamedPreviewTunnel, _transport } from '../../src/services/pairing.service';

// codeagent-fndr: /api/preview/tunnel is behind PluginAuthGuard, which reads
// sessionId AND pluginId from the body to verify the HMAC. The CLI sent only
// pluginId, so every call was a 401 PLUGIN_TOKEN_REQUIRED and every preview
// fell back to a *.trycloudflare.com quick tunnel.
describe('fetchNamedPreviewTunnel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs sessionId + pluginId with the plugin-auth token', async () => {
    const spy = vi
      .spyOn(_transport, 'postJsonAuthed')
      .mockResolvedValue({ hostname: 'preview-abc.codeagent-mobile.com', token: 'minted' });

    await expect(
      fetchNamedPreviewTunnel({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' }),
    ).resolves.toEqual({ hostname: 'preview-abc.codeagent-mobile.com', token: 'minted' });

    const [url, body, token] = spy.mock.calls[0];
    expect(url).toMatch(/\/api\/preview\/tunnel$/);
    expect(token).toBe('tok');
    expect(body).toEqual({ sessionId: 's1', pluginId: 'p1' });
  });

  it('answers null when the backend has no named tunnel to give', async () => {
    vi.spyOn(_transport, 'postJsonAuthed').mockResolvedValue(null);
    await expect(
      fetchNamedPreviewTunnel({ sessionId: 's1', pluginId: 'p1', pluginAuthToken: 'tok' }),
    ).resolves.toBeNull();
  });
});
