import { extractRequestToken, isAuthorized, jsonError, requireAdminAuth } from './auth/bearer.ts';
import { KeyPoolDO } from './durable-objects/key-pool-do.ts';
import { SchedulerDO } from './durable-objects/scheduler-do.ts';
import { executeAgentDispatch, queryAgentDispatchStatus } from './executors/agent.ts';
import { executeGeminiNativeChat, executeOpenAICompatChat } from './executors/chat.ts';
import { executeDecisionModel, resolveDecisionModelId } from './executors/decision.ts';
import { listGeminiModels } from './providers/gemini.ts';
import type { OpenAIChatRequest } from './providers/openai-compat.ts';
import { classifyModel } from './router/classifier.ts';
import type { AgentDispatchRequest, DecisionRequest, Env } from './types.ts';

export { KeyPoolDO, SchedulerDO };

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-goog-api-key, x-goog-api-client',
      'access-control-max-age': '86400',
    },
  });
}

function schedulerStub(env: Env): DurableObjectStub {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName('global-scheduler'));
}

function keyPoolStub(env: Env): DurableObjectStub {
  return env.KEY_POOL.get(env.KEY_POOL.idFromName('global-gemini-key-pool'));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsPreflight();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Public health check
    if (request.method === 'GET' && (path === '/' || path === '/healthz')) {
      return Response.json(
        {
          ok: true,
          service: 'anyworkflow-gemini-gateway',
          categories: ['agent', 'chat', 'decision'],
          domain: url.hostname,
        },
        { headers: { 'access-control-allow-origin': '*' } },
      );
    }

    // 2. Admin endpoints (KeyPoolDO & SchedulerDO)
    if (path.startsWith('/admin/')) {
      const authErr = requireAdminAuth(request, env.ADMIN_AUTH_TOKEN, env.GATEWAY_AUTH_TOKEN);
      if (authErr) return authErr;

      if (path === '/admin/keys/status' && request.method === 'GET') {
        const res = await keyPoolStub(env).fetch('https://key-pool/status');
        return new Response(res.body, {
          status: res.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
        });
      }
      if (path === '/admin/keys/reset' && request.method === 'POST') {
        const res = await keyPoolStub(env).fetch('https://key-pool/reset', { method: 'POST' });
        return new Response(res.body, {
          status: res.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
        });
      }

      if (path === '/admin/schedules' || path.startsWith('/admin/schedules/')) {
        const doPath = path.replace(/^\/admin/, '');
        const res = await schedulerStub(env).fetch(`https://scheduler${doPath}${url.search}`, {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          body: request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text(),
        });
        return new Response(res.body, {
          status: res.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
        });
      }

      return jsonError(404, 'Unknown admin endpoint');
    }

    // 3. Gateway auth check for AI inference & dispatch endpoints
    if (!isAuthorized(request, env.GATEWAY_AUTH_TOKEN)) {
      return jsonError(401, 'Invalid gateway token');
    }

    // If GATEWAY_AUTH_TOKEN is not set and GEMINI_API_KEYS is empty, allow caller key passthrough
    const callerKey = !env.GEMINI_API_KEYS ? extractRequestToken(request) || undefined : undefined;

    try {
      // 4. Google Gemini Native API (/v1beta/models...) — RikkaHub official streaming compatibility
      if (request.method === 'GET' && path === '/v1beta/models') {
        return await listGeminiModels(env, callerKey);
      }

      const geminiMatch = path.match(/^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/);
      if (request.method === 'POST' && geminiMatch) {
        const model = decodeURIComponent(geminiMatch[1]!);
        const action = geminiMatch[2] as 'generateContent' | 'streamGenerateContent';
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return jsonError(400, 'Invalid JSON body');

        const category = classifyModel(model);
        if (category === 'agent') {
          return await executeAgentDispatch(env, {
            model,
            inputs: { prompt_json: JSON.stringify(body).slice(0, 8000) },
          });
        }

        const effectiveModel = category === 'decision' ? resolveDecisionModelId(model, env) : model;
        if (category === 'decision') {
          const genCfg = ((body.generationConfig as Record<string, unknown> | undefined) ?? {});
          if (!genCfg.responseMimeType) {
            genCfg.responseMimeType = 'application/json';
          }
          body.generationConfig = genCfg;
        }

        const streamSse = url.searchParams.get('alt') !== 'json';
        return await executeGeminiNativeChat(env, effectiveModel, action, body, streamSse, callerKey, ctx);
      }

      // 5. OpenAI-Compatible API (/v1/models, /v1/chat/completions)
      if (request.method === 'GET' && path === '/v1/models') {
        const res = await listGeminiModels(env, callerKey);
        if (!res.ok) return res;
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        return Response.json(
          {
            object: 'list',
            data: (data.models ?? []).map((m) => ({
              id: m.name.replace(/^models\//, ''),
              object: 'model',
              owned_by: 'google',
            })),
          },
          { headers: { 'access-control-allow-origin': '*' } },
        );
      }

      if (request.method === 'POST' && path === '/v1/chat/completions') {
        const body = (await request.json().catch(() => null)) as OpenAIChatRequest | null;
        if (!body || !body.model || !Array.isArray(body.messages)) {
          return jsonError(400, 'Invalid OpenAI chat completions payload');
        }

        const category = classifyModel(body.model);
        if (category === 'agent') {
          return await executeAgentDispatch(env, {
            model: body.model,
            inputs: {
              prompt_json: JSON.stringify(body.messages).slice(0, 8000),
            },
          });
        }

        const effectiveBody =
          category === 'decision'
            ? { ...body, model: resolveDecisionModelId(body.model, env) }
            : body;

        return await executeOpenAICompatChat(env, effectiveBody, callerKey, ctx);
      }

      // 6. Class 1: Explicit Agent Dispatch API (triggers GitHub Actions)
      if (request.method === 'POST' && path === '/v1/agent/dispatch') {
        const body = (await request.json().catch(() => ({}))) as AgentDispatchRequest;
        return await executeAgentDispatch(env, body);
      }

      const agentStatusMatch = path.match(/^\/v1\/agent\/runs\/([^/]+)$/);
      if (request.method === 'GET' && agentStatusMatch) {
        const requestId = decodeURIComponent(agentStatusMatch[1]!);
        const workflow = url.searchParams.get('workflow') || undefined;
        return await queryAgentDispatchStatus(env, requestId, workflow);
      }

      // 7. Class 3: Explicit Decision Model API (structured JSON in Worker)
      if (request.method === 'POST' && path === '/v1/decision') {
        const body = (await request.json().catch(() => null)) as DecisionRequest | null;
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
          return jsonError(400, 'prompt is required');
        }
        const result = await executeDecisionModel(env, body, callerKey, ctx);
        return Response.json(result.data, {
          status: result.status,
          headers: { 'access-control-allow-origin': '*' },
        });
      }

      return jsonError(404, `Route not found: ${request.method} ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(500, message);
    }
  },
};
