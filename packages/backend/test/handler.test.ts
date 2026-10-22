import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { AnalyzeResponse, ModelAnalysis } from '@qa/core';
import { AnalyzeError } from '../src/bedrock';
import { createHandler } from '../src/handler';

const SECRET = 'secret_marker_123';

function analysis(): ModelAnalysis {
  return {
    is_query: true,
    not_a_query_message: '',
    query_type: { language: 'postgresql', dialect_note: '', confidence: 'medium' },
    what_it_does: 'Deletes rows.',
    detailed_explanation: 'Deletes from orders.',
    simple_explanation: 'Removes orders.',
    step_by_step: [{ snippet: 'DELETE FROM orders', explanation: 'Deletes.' }],
    improvements: [],
    rewritten_query: { query: '', reason: '' },
    security: { level: 'none', findings: [] },
    danger: { level: 'none', can_change_data: 'no', data_change_summary: 'Nothing.', findings: [] },
    performance: { level: 'none', findings: [] },
  };
}

function okResult() {
  return { analysis: analysis(), usage: { inputTokens: 11, outputTokens: 22 }, latencyMs: 33, mode: 'structured' as const };
}

interface EventOpts {
  method?: string;
  path?: string;
  secret?: string | null;
  body?: string;
  base64?: boolean;
}

function makeEvent(o: EventOpts = {}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (o.secret !== null) headers['x-app-secret'] = o.secret ?? SECRET;
  return {
    version: '2.0',
    rawPath: o.path ?? '/api/analyze',
    headers,
    isBase64Encoded: o.base64 ?? false,
    body: o.body,
    requestContext: { http: { method: o.method ?? 'POST', path: o.path ?? '/api/analyze' } },
  } as unknown as APIGatewayProxyEventV2;
}

const post = (query: unknown, extra: EventOpts = {}) => makeEvent({ body: JSON.stringify({ query }), ...extra });

function setup(analyzeImpl?: (q: string) => Promise<ReturnType<typeof okResult>>) {
  const analyze = vi.fn(analyzeImpl ?? (async () => okResult()));
  const log = vi.fn();
  const getSecret = vi.fn(async () => SECRET);
  const handler = createHandler({ getSecret, analyze, log, profile: 'profile-1' });
  return { handler, analyze, log, getSecret };
}

const parse = (body: string) => JSON.parse(body) as AnalyzeResponse;

describe('auth and routing', () => {
  it('GET /api/check with the right secret is 204', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ method: 'GET', path: '/api/check' }));
    expect(res.statusCode).toBe(204);
  });

  it('wrong secret is 401', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ method: 'GET', path: '/api/check', secret: 'nope' }));
    expect(res.statusCode).toBe(401);
    expect(parse(res.body)).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('missing secret header is 401', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ method: 'GET', path: '/api/check', secret: null }));
    expect(res.statusCode).toBe(401);
  });

  it('a secret of a different length is 401, not a crash', async () => {
    const { handler } = setup();
    for (const secret of ['x', SECRET + 'extra', '']) {
      const res = await handler(makeEvent({ method: 'GET', path: '/api/check', secret }));
      expect(res.statusCode).toBe(401);
    }
  });

  it('auth failure does not call analyze', async () => {
    const { handler, analyze } = setup();
    const res = await handler(post('SELECT 1', { secret: 'nope' }));
    expect(res.statusCode).toBe(401);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('auth runs before the body is touched', async () => {
    const { handler, analyze } = setup();
    const res = await handler(makeEvent({ secret: null, body: '{not json', base64: true }));
    expect(res.statusCode).toBe(401);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('GET /api/analyze is 405', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ method: 'GET', path: '/api/analyze' }));
    expect(res.statusCode).toBe(405);
  });

  it('unknown path is 404', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ method: 'GET', path: '/nope' }));
    expect(res.statusCode).toBe(404);
  });

  it('a getSecret failure is 500 failed with a fixed message', async () => {
    const analyze = vi.fn(async () => okResult());
    const handler = createHandler({
      getSecret: async () => {
        throw new Error('arn:aws:secretsmanager:boom');
      },
      analyze,
      log: vi.fn(),
    });
    const res = await handler(makeEvent({ method: 'GET', path: '/api/check' }));
    expect(res.statusCode).toBe(500);
    expect(parse(res.body)).toMatchObject({ ok: false, error: 'failed' });
    expect(res.body).not.toContain('boom');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('responses are json and not cached', async () => {
    const { handler } = setup();
    const res = await handler(post('SELECT 1'));
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/analyze', () => {
  it('POST /api/analyze with a valid body returns ok with a finalized analysis', async () => {
    const { handler, analyze } = setup();
    const res = await handler(post('DELETE FROM orders;'));
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.analysis.danger.level).toBe('high');
    expect(analyze).toHaveBeenCalledWith('DELETE FROM orders;');
  });

  it('base64 body is decoded', async () => {
    const { handler, analyze } = setup();
    const body = Buffer.from(JSON.stringify({ query: 'SELECT 1' }), 'utf8').toString('base64');
    const res = await handler(makeEvent({ body, base64: true }));
    expect(res.statusCode).toBe(200);
    expect(analyze).toHaveBeenCalledWith('SELECT 1');
  });

  it('non-JSON body is 400 bad_request', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ body: 'not json' }));
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('a missing body is 400 bad_request', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it('query missing is 400', async () => {
    const { handler } = setup();
    const res = await handler(makeEvent({ body: '{}' }));
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: 'bad_request' });
  });

  it('empty is 400 empty', async () => {
    const { handler } = setup();
    const res = await handler(post('   '));
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: 'empty' });
  });

  it('20001 chars is 400 too_long', async () => {
    const { handler, analyze } = setup();
    const res = await handler(post('a'.repeat(20001)));
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: 'too_long' });
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe('analyze failures', () => {
  const cases: [string, 'throttled' | 'bad_output' | 'failed', number][] = [
    ['AnalyzeError throttled is 429', 'throttled', 429],
    ['AnalyzeError bad_output is 502', 'bad_output', 502],
    ['AnalyzeError failed is 500', 'failed', 500],
  ];
  for (const [name, code, status] of cases) {
    it(name, async () => {
      const { handler } = setup(async () => {
        throw new AnalyzeError(code, 'SomeDetail');
      });
      const res = await handler(post('SELECT 1'));
      expect(res.statusCode).toBe(status);
      const body = parse(res.body);
      expect(body).toMatchObject({ ok: false, error: code });
      expect(res.body).not.toContain('SomeDetail');
    });
  }

  it('unexpected exception is 500 failed with a fixed message', async () => {
    const { handler } = setup(async () => {
      throw new Error('kaboom internal detail');
    });
    const res = await handler(post('SELECT 1'));
    expect(res.statusCode).toBe(500);
    const body = parse(res.body);
    expect(body).toMatchObject({ ok: false, error: 'failed', message: "Couldn't analyse that. Try again." });
    expect(res.body).not.toContain('kaboom');
  });
});

describe('logging', () => {
  it('the log line has rule IDs and token counts and contains neither the query text nor the secret', async () => {
    const { handler, log } = setup();
    const query = `DELETE FROM orders; SELECT secret_marker_123`;
    await handler(post(query));
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as Record<string, unknown>;
    expect(line).toMatchObject({
      event: 'analyze',
      profile: 'profile-1',
      inputTokens: 11,
      outputTokens: 22,
      latencyMs: 33,
    });
    expect(line.ruleIds).toContain('delete-update-no-where');
    expect(line).not.toHaveProperty('errorCode');
    const text = JSON.stringify(line);
    expect(text).not.toContain('secret_marker_123');
    expect(text).not.toContain('DELETE');
  });

  it('logs the error code with zero counts on an analyze failure', async () => {
    const { handler, log } = setup(async () => {
      throw new AnalyzeError('throttled', 'ThrottlingException');
    });
    await handler(post('DELETE FROM orders;'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      event: 'analyze',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      errorCode: 'throttled',
    });
  });

  it('logs a rejected body with no rule ids', async () => {
    const { handler, log } = setup();
    await handler(post(''));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ ruleIds: [], errorCode: 'empty' });
  });

  it('does not log on an auth failure or the check route', async () => {
    const { handler, log } = setup();
    await handler(post('SELECT 1', { secret: 'nope' }));
    await handler(makeEvent({ method: 'GET', path: '/api/check' }));
    expect(log).not.toHaveBeenCalled();
  });
});
