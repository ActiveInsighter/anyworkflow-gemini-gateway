import assert from 'node:assert/strict';
import test from 'node:test';
import { executeDecisionModel, resolveDecisionModelId } from '../src/executors/decision.ts';
import type { Env } from '../src/types.ts';

const baseEnv = {
  DEFAULT_DECISION_MODEL: 'gemini-2.5-flash',
} as Env;

test('resolveDecisionModelId maps gemini-decision alias to DEFAULT_DECISION_MODEL', () => {
  assert.equal(resolveDecisionModelId('gemini-decision', baseEnv), 'gemini-2.5-flash');
  assert.equal(resolveDecisionModelId('models/gemini-decision', baseEnv), 'gemini-2.5-flash');
  assert.equal(resolveDecisionModelId('decision', baseEnv), 'gemini-2.5-flash');
  assert.equal(resolveDecisionModelId('', baseEnv), 'gemini-2.5-flash');
  assert.equal(resolveDecisionModelId(undefined, baseEnv), 'gemini-2.5-flash');
});

test('Decision defaults to Gemini 3.5 Flash-Lite without an override', () => {
  const env = { DEFAULT_DECISION_MODEL: ' ' } as Env;
  assert.equal(resolveDecisionModelId('gemini-decision', env), 'gemini-3.5-flash-lite');
});

test('resolveDecisionModelId preserves explicit real Gemini model IDs', () => {
  assert.equal(resolveDecisionModelId('gemini-2.5-pro', baseEnv), 'gemini-2.5-pro');
  assert.equal(resolveDecisionModelId('models/gemini-3-flash-preview', baseEnv), 'gemini-3-flash-preview');
});

test('Decision forwards past turns once and uses the resolved Gemini thinking config', async (t) => {
  const requests: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({
      candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '```json\n{"choice":"B"}\n```' }] } }],
    });
  });
  const result = await executeDecisionModel(baseEnv, {
    model: 'gemini-decision',
    prompt: 'choose now',
    messages: [
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'choose now' },
    ],
    thinkingLevel: 'low',
  }, 'test-key');
  assert.deepEqual((result.data as { decision: unknown }).decision, { choice: 'B' });
  assert.match(requests[0]!.url, /gemini-2\.5-flash:generateContent$/);
  assert.deepEqual(requests[0]!.body.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  assert.deepEqual(requests[0]!.body.contents.map((entry: { role: string }) => entry.role), ['user', 'model', 'user']);

  await executeDecisionModel(baseEnv, { model: 'gemini-3.1-pro-preview', prompt: 'choose', thinkingLevel: 'off' }, 'test-key');
  assert.deepEqual(requests[1]!.body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
});
