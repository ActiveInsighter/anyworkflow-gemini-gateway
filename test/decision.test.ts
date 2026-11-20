import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDecisionModelId } from '../src/executors/decision.ts';
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

test('resolveDecisionModelId preserves explicit real Gemini model IDs', () => {
  assert.equal(resolveDecisionModelId('gemini-2.5-pro', baseEnv), 'gemini-2.5-pro');
  assert.equal(resolveDecisionModelId('models/gemini-3-flash-preview', baseEnv), 'gemini-3-flash-preview');
});
