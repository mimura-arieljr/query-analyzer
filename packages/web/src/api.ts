import type { AnalyzeResponse } from '@qa/core/types';

const FAILED: AnalyzeResponse = {
  ok: false,
  error: 'failed',
  message: "Couldn't analyse that. Try again.",
};

function isAnalyzeResponse(data: unknown): data is AnalyzeResponse {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.ok === true) return typeof d.analysis === 'object' && d.analysis !== null;
  if (d.ok === false) return typeof d.error === 'string' && typeof d.message === 'string';
  return false;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function checkSecret(
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'wrong' | 'error'> {
  try {
    const res = await fetchImpl('/api/check', { cache: 'no-store', headers: { 'x-app-secret': secret } });
    if (res.status === 204) return 'ok';
    if (res.status === 401) return 'wrong';
    return 'error';
  } catch {
    return 'error';
  }
}

export async function analyze(
  query: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnalyzeResponse> {
  try {
    const body = JSON.stringify({ query });
    const res = await fetchImpl('/api/analyze', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-secret': secret,
        'x-amz-content-sha256': await sha256Hex(body),
      },
      body,
    });
    const data: unknown = await res.json();
    return isAnalyzeResponse(data) ? data : FAILED;
  } catch {
    return FAILED;
  }
}
