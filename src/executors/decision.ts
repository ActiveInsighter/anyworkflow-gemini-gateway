import { callGeminiUpstream } from '../providers/gemini.ts';
import type { DecisionRequest, Env } from '../types.ts';

/**
 * Class 3 Executor: Decision models (e.g. gemini-decision / structured JSON routing).
 * Runs directly in Cloudflare Worker with responseMimeType = "application/json"
 * for sub-second structured decision output.
 */
export async function executeDecisionModel(
  env: Env,
  req: DecisionRequest,
  overrideApiKey?: string,
): Promise<{ status: number; data: unknown }> {
  const model = (req.model || env.DEFAULT_DECISION_MODEL || 'gemini-2.5-flash').replace(/^models\//i, '');
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: req.temperature ?? 0.1,
    maxOutputTokens: req.maxOutputTokens ?? 2048,
  };

  if (req.schema) {
    generationConfig.responseSchema = req.schema;
  }
  if (req.thinkingLevel) {
    const level = req.thinkingLevel.toUpperCase();
    if (level === 'OFF' || level === 'NONE') {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else if (['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level)) {
      generationConfig.thinkingConfig = { thinkingLevel: level };
    }
  }

  const payload: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
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
  });

  const raw = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
  if (!upstream.ok || !raw) {
    return {
      status: upstream.status,
      data: {
        category: 'decision',
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
    decision = JSON.parse(text);
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
