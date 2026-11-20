import { callGeminiUpstream } from '../providers/gemini.ts';
import {
  geminiToOpenAIResponse,
  openAIToGeminiRequest,
  transformGeminiSseToOpenAISse,
  type OpenAIChatRequest,
} from '../providers/openai-compat.ts';
import type { Env } from '../types.ts';

/**
 * Class 2 Executor: Ordinary Chat models.
 * - Native Gemini endpoint (/v1beta/models/{model}:streamGenerateContent?alt=sse):
 *   Zero-overhead SSE passthrough so RikkaHub receives the exact official Google stream
 *   (including thought / thoughtSignature / usageMetadata / candidates).
 * - OpenAI endpoint (/v1/chat/completions):
 *   Translates to/from Gemini format with full SSE streaming support.
 */
export async function executeGeminiNativeChat(
  env: Env,
  model: string,
  action: 'generateContent' | 'streamGenerateContent',
  body: unknown,
  streamSse: boolean,
  overrideApiKey?: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const upstream = await callGeminiUpstream(env, {
    model,
    action,
    body,
    streamSse,
    overrideApiKey,
    ctx,
  });

  const headers = new Headers();
  headers.set('access-control-allow-origin', '*');
  headers.set('cache-control', 'no-cache');

  if (action === 'streamGenerateContent' && upstream.ok) {
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.set('connection', 'keep-alive');
    headers.set('x-accel-buffering', 'no');
  } else {
    headers.set('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function executeOpenAICompatChat(
  env: Env,
  body: OpenAIChatRequest,
  overrideApiKey?: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const model = body.model.replace(/^models\//i, '');
  const stream = body.stream === true;
  const geminiPayload = openAIToGeminiRequest(body);

  const upstream = await callGeminiUpstream(env, {
    model,
    action: stream ? 'streamGenerateContent' : 'generateContent',
    body: geminiPayload,
    streamSse: true,
    overrideApiKey,
    ctx,
  });

  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
  }

  if (stream && upstream.body) {
    const openAIStream = transformGeminiSseToOpenAISse(upstream.body, model);
    return new Response(openAIStream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      },
    });
  }

  const data = (await upstream.json()) as Record<string, unknown>;
  return Response.json(geminiToOpenAIResponse(data, model), {
    headers: { 'access-control-allow-origin': '*' },
  });
}
