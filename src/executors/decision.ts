import { callGeminiUpstream } from '../providers/gemini.ts';
import type { DecisionRequest, Env } from '../types.ts';

const DECISION_ALIAS_RE = /^(?:gemini[-_.]?)?decision$/i;

export function resolveDecisionModelId(requestedModel: string | undefined, env: Env): string {
  const clean = (requestedModel || '').trim().replace(/^models\//i, '');
  if (!clean || DECISION_ALIAS_RE.test(clean)) {
    return (env.DEFAULT_DECISION_MODEL || 'gemini-2.5-flash').trim().replace(/^models\//i, '');
  }
  return clean;
}

function buildDecisionThinkingConfig(model: string, thinkingLevel?: string): Record<string, unknown> | undefined {
  if (!thinkingLevel?.trim()) return undefined;
  const level = thinkingLevel.trim().toUpperCase();
  const isGemini3 = /^gemini-3/i.test(model);

  if (isGemini3) {
    if (level === 'OFF' || level === 'NONE') return { thinkingLevel: 'MINIMAL' };
    if (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) return { thinkingLevel: level };
    return undefined;
  }

  // Gemini 2.5 models use thinkingBudget (not thinkingLevel)
  if (level === 'OFF' || level === 'NONE') return { thinkingBudget: 0 };
  if (level === 'MINIMAL' || level === 'LOW') return { thinkingBudget: 1024 };
  if (level === 'MEDIUM') return { thinkingBudget: 8192 };
  if (level === 'HIGH' || level === 'XHIGH' || level === 'MAX') return { thinkingBudget: 24576 };
  return undefined;
}

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}

/**
 * Class 3 Executor: Decision models (e.g. gemini-decision / structured JSON routing).
 * Runs directly in Cloudflare Worker with responseMimeType = "application/json"
 * for sub-second structured decision output.
 */
export async function executeDecisionModel(
  env: Env,
  req: DecisionRequest,
  overrideApiKey?: string,
  ctx?: ExecutionContext,
): Promise<{ status: number; data: unknown }> {
  const model = resolveDecisionModelId(req.model, env);
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: req.temperature ?? 0.1,
    maxOutputTokens: req.maxOutputTokens ?? 2048,
  };

  if (req.schema) {
    generationConfig.responseSchema = req.schema;
  }
  const thinkingConfig = buildDecisionThinkingConfig(model, req.thinkingLevel);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    for (const msg of req.messages) {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) continue;
      const role = msg.role?.toLowerCase() === 'assistant' || msg.role?.toLowerCase() === 'model' ? 'model' : 'user';
      contents.push({ role, parts: [{ text }] });
    }
  }
  const promptText = req.prompt.trim();
  if (contents.length === 0 || contents[contents.length - 1]?.role !== 'user' || contents[contents.length - 1]?.parts[0]?.text !== promptText) {
    contents.push({ role: 'user', parts: [{ text: promptText }] });
  }

  const payload: Record<string, unknown> = {
    contents,
    generationConfig,
  };
  if (req.systemPrompt?.trim()) {
    payload.systemInstruction = { parts: [{ text: req.systemPrompt.trim() }] };
  }

  const upstream = await callGeminiUpstream(env, {
    model,
    action: 'generateContent',
    body: payload,
    overrideApiKey,
    ctx,
  });

  const raw = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
  if (!upstream.ok || !raw) {
    return {
      status: upstream.status,
      data: {
        category: 'decision',
        model,
        error: raw ?? 'Upstream decision request failed',
      },
    };
  }

  const candidates = (raw.candidates as Array<Record<string, unknown>> | undefined) ?? [];
  const parts =
    ((candidates[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined) ?? [];

  const text = parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');

  let decision: unknown = text;
  try {
    decision = JSON.parse(stripJsonCodeFence(text));
  } catch {
    // Keep raw text if model returned non-JSON despite mimeType
  }

  return {
    status: 200,
    data: {
      category: 'decision',
      model,
      decision,
      usage: raw.usageMetadata ?? null,
    },
  };
}
