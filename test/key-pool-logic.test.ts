import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyUpstreamError,
  computeCooldownMs,
  maskApiKey,
  parseApiKeys,
  parseKeyGroups,
} from '../src/durable-objects/key-pool-logic.ts';

test('parseApiKeys splits by comma, newline, and whitespace', () => {
  assert.deepEqual(parseApiKeys('k1, k2\nk3;k4'), ['k1', 'k2', 'k3', 'k4']);
  assert.deepEqual(parseApiKeys(''), []);
});

test('parseKeyGroups maps indexed and positional groups', () => {
  assert.deepEqual(parseKeyGroups(3, '0:projA,1:projA'), ['group:projA', 'group:projA', 'key:2']);
  assert.deepEqual(parseKeyGroups(3, 'p1,p2,p1'), ['group:p1', 'group:p2', 'group:p1']);
});

test('classifyUpstreamError differentiates rate_limit, daily_exhausted, and permanent_invalid', () => {
  assert.equal(classifyUpstreamError(429, { error: { message: 'Quota exceeded per minute' } }), 'rate_limit');
  assert.equal(
    classifyUpstreamError(429, { error: { message: 'GenerateRequestsPerDayPerProjectPerModel' } }),
    'daily_exhausted',
  );
  assert.equal(classifyUpstreamError(400, { error: { details: [{ reason: 'API_KEY_INVALID' }] } }), 'permanent_invalid');
  assert.equal(classifyUpstreamError(400, { error: { message: 'Invalid JSON in user prompt' } }), 'none');
});

test('computeCooldownMs uses Retry-After or exponential backoff capped at 300s', () => {
  assert.equal(computeCooldownMs(0), 20_000);
  assert.equal(computeCooldownMs(2), 80_000);
  assert.equal(computeCooldownMs(10), 300_000);
  assert.equal(computeCooldownMs(0, 45), 45_000);
});

test('maskApiKey hides middle characters', () => {
  assert.equal(maskApiKey('AIzaSyA1234567890wxyz'), 'AIzaSy...wxyz');
  assert.equal(maskApiKey('short'), '***');
});
