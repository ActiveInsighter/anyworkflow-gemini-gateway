import type { ModelCategory } from '../types.ts';

const AGENT_PATTERNS = [
  /^antigravity/i,
  /^deep-research/i,
  /^agent[-_/]/i,
];

const DECISION_PATTERNS = [
  /decision/i,
  /^gemini[-_.]decision/i,
];

export function stripModelsPrefix(model: string): string {
  return model.trim().replace(/^models\//i, '');
}

/**
 * Classifies an AI request into one of three execution tiers:
 * - 'agent': long-running / sandbox / Antigravity tasks -> dispatched to GitHub Actions
 * - 'decision': fast structured JSON decision tasks -> executed directly in Worker
 * - 'chat': ordinary conversational models -> executed directly in Worker with SSE streaming
 */
export function classifyModel(
  model: string,
  explicitCategory?: string | null,
): ModelCategory {
  if (explicitCategory === 'agent' || explicitCategory === 'chat' || explicitCategory === 'decision') {
    return explicitCategory;
  }

  const normalized = stripModelsPrefix(model);
  if (AGENT_PATTERNS.some((re) => re.test(normalized))) {
    return 'agent';
  }
  if (DECISION_PATTERNS.some((re) => re.test(normalized))) {
    return 'decision';
  }
  return 'chat';
}
