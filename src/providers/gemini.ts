import type { Env, KeyLease } from '../types.ts';

function keyPoolStub(env: Env): DurableObjectStub {
  const id = env.KEY_POOL.idFromName('global-gemini-key-pool');
  return env.KEY_POOL.get(id);
}

export async function leaseApiKey(env: Env, excludeHashes: string[] = []): Promise<KeyLease> {
  const res = await keyPoolStub(env).fetch('https://key-pool/lease', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ excludeHashes }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `KeyPool lease failed (${res.status})`);
  }
  return (await res.json()) as KeyLease;
}

export async function reportApiKeyOutcome(
  env: Env,
  keyHash: string,
  status: number,
  retryAfterSeconds?: number,
  errorPayload?: unknown,
): Promise<void> {
  await keyPoolStub(env).fetch('https://key-pool/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyHash, status, retryAfterSeconds, errorPayload }),
  });
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const num = Number.parseFloat(headerValue);
  if (Number.isFinite(num) && num > 0) return num;
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, (dateMs - Date.now()) / 1000);
  }
  return undefined;
}

export interface GeminiCallOptions {
  model: string;
  action: 'generateContent' | 'streamGenerateContent';
  body: unknown;
  streamSse?: boolean;
  maxAttempts?: number;
  overrideApiKey?: string;
}

/**
 * Calls Google Gemini REST API with automatic KeyPool rotation and retry on 429/503.
 */
export async function callGeminiUpstream(env: Env, opts: GeminiCallOptions): Promise<Response> {
  const base = (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const cleanModel = opts.model.replace(/^models\//i, '');
  const query = opts.action === 'streamGenerateContent' && opts.streamSse !== false ? '?alt=sse' : '';
  const targetUrl = `${base}/models/${encodeURIComponent(cleanModel)}:${opts.action}${query}`;

  if (opts.overrideApiKey) {
    return fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': opts.overrideApiKey,
      },
      body: JSON.stringify(opts.body),
    });
  }

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const triedHashes: string[] = [];
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const lease = await leaseApiKey(env, triedHashes);
    triedHashes.push(lease.keyHash);

    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': lease.key,
      },
      body: JSON.stringify(opts.body),
    });

    if (upstream.ok) {
      // Report success asynchronously
      await reportApiKeyOutcome(env, lease.keyHash, upstream.status);
      return upstream;
    }

    const retryAfter = parseRetryAfter(upstream.headers.get('retry-after'));
    let errorBody: unknown = null;
    const rawText = await upstream.text().catch(() => '');
    try {
      errorBody = JSON.parse(rawText);
    } catch {
      errorBody = rawText;
    }

    await reportApiKeyOutcome(env, lease.keyHash, upstream.status, retryAfter, errorBody);

    lastResponse = new Response(rawText, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      },
    });

    // Retry on rate limit or transient upstream 5xx with another key
    if (upstream.status !== 429 && upstream.status < 500) {
      return lastResponse;
    }
  }

  return lastResponse ?? new Response('Upstream Gemini request failed', { status: 502 });
}

export async function listGeminiModels(env: Env, overrideApiKey?: string): Promise<Response> {
  const base = (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const apiKey = overrideApiKey || (await leaseApiKey(env)).key;
  const res = await fetch(`${base}/models?pageSize=100`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
