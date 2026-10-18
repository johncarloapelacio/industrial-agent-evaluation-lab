import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, duration, getToken, pretty, providerLabel, setToken } from './api';

describe('review API authorization', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the configured reviewer credential for mutations and omits it from read requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'run' }) });
    vi.stubGlobal('fetch', fetchMock);
    setToken('reviewer-secret');
    await api('/runs', { scenario_id: 'pump' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/runs',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer reviewer-secret' },
        body: '{"scenario_id":"pump"}',
      }),
    );
    await api('/runs');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/runs', { method: 'GET', headers: {} });
    expect(getToken()).toBe('reviewer-secret');
  });

  it('preserves API denial messages and handles a non-JSON gateway failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          json: async () => ({ detail: 'Reviewer authorization required' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('HTML');
          },
        }),
    );
    await expect(api('/runs', {})).rejects.toThrow('Reviewer authorization required');
    await expect(api('/runs')).rejects.toThrow('Request failed (502)');
  });
});

describe('honest display formatting', () => {
  it('retains subsecond latency and labels scripted providers distinctly from live execution', () => {
    expect(duration(18)).toBe('18 ms');
    expect(duration(1250)).toBe('1.3 s');
    expect(providerLabel('baseline')).toBe('Deterministic baseline');
    expect(providerLabel('careless')).toBe('Flawed candidate');
    expect(providerLabel('openai-compatible')).toBe('Live model');
    expect(pretty(null)).toBe('null');
    expect(pretty({ status: 'draft' })).toContain('"status": "draft"');
  });
});
