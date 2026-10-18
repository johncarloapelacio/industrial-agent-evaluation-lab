const TOKEN_KEY = 'industrial-lab-review-token';
export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? 'local-review-key';
}
export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined
        ? {}
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const error = await response.json();
      message = typeof error.detail === 'string' ? error.detail : (error.error?.message ?? message);
    } catch {
      /* Preserve status for non-JSON gateway failures. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export function pretty(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '—');
}
export function shortId(id: string): string {
  return id.slice(0, 8);
}
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
export function providerLabel(provider: string): string {
  return provider === 'baseline'
    ? 'Deterministic baseline'
    : provider === 'careless'
      ? 'Flawed candidate'
      : 'Live model';
}
