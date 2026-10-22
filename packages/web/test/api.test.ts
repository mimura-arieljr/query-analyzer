import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { analyze, checkSecret, sha256Hex } from '../src/api';

const FAILED = { ok: false, error: 'failed', message: "Couldn't analyse that. Try again." };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('sha256Hex', () => {
  it('matches the standard test vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('analyze', () => {
  it('sends the body hash header matching the body bytes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, analysis: {} }));
    await analyze('select 1', 's3cret', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/analyze');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ query: 'select 1' }));
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-amz-content-sha256']).toBe(await sha256Hex(init.body as string));
  });

  it('sends x-app-secret', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, analysis: {} }));
    await analyze('select 1', 's3cret', fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-app-secret']).toBe('s3cret');
  });

  it('maps a network error to failed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    });
    expect(await analyze('q', 's', fetchImpl as unknown as typeof fetch)).toEqual(FAILED);
  });

  it('returns the server error code on 401/429', async () => {
    for (const [status, error] of [
      [401, 'unauthorized'],
      [429, 'throttled'],
    ] as const) {
      const body = { ok: false, error, message: 'nope' };
      const fetchImpl = vi.fn(async () => jsonResponse(status, body));
      expect(await analyze('q', 's', fetchImpl as unknown as typeof fetch)).toEqual(body);
    }
  });

  it('maps a response without an ok field to failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await analyze('q', 's', fetchImpl as unknown as typeof fetch)).toEqual(FAILED);
  });

  it('hashes the exact UTF-8 bytes of a non-ASCII body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, analysis: {} }));
    const query = "SELECT '😀 日本語' AS greeting";
    await analyze(query, 's', fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const expected = createHash('sha256').update(init.body as string, 'utf8').digest('hex');
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBe(expected);
    expect(init.body).toContain('😀 日本語');
  });

  it('maps ok:true without an analysis object to failed', async () => {
    for (const body of [{ ok: true }, { ok: true, analysis: 'x' }, { ok: true, analysis: null }]) {
      const fetchImpl = vi.fn(async () => jsonResponse(200, body));
      expect(await analyze('q', 's', fetchImpl as unknown as typeof fetch)).toEqual(FAILED);
    }
  });

  it('maps ok:false without string error and message to failed', async () => {
    for (const body of [{ ok: false }, { ok: false, error: 1, message: 'm' }, { ok: false, error: 'e' }]) {
      const fetchImpl = vi.fn(async () => jsonResponse(400, body));
      expect(await analyze('q', 's', fetchImpl as unknown as typeof fetch)).toEqual(FAILED);
    }
  });
});

describe('checkSecret', () => {
  const withStatus = (status: number) =>
    vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

  it('returns ok on 204, wrong on 401, error on a network failure', async () => {
    expect(await checkSecret('s', withStatus(204))).toBe('ok');
    expect(await checkSecret('s', withStatus(401))).toBe('wrong');
    expect(await checkSecret('s', withStatus(500))).toBe('error');
    const down = vi.fn(async () => {
      throw new TypeError('network down');
    });
    expect(await checkSecret('s', down as unknown as typeof fetch)).toBe('error');
  });

  it('GETs /api/check with x-app-secret', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await checkSecret('s3cret', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/check');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['x-app-secret']).toBe('s3cret');
  });
})