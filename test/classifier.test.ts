import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyModel, stripModelsPrefix } from '../src/router/classifier.ts';

test('classifyModel routes antigravity and deep-research to agent', () => {
  assert.equal(classifyModel('antigravity-preview-09-2026'), 'agent');
  assert.equal(classifyModel('models/antigravity-pro'), 'agent');
  assert.equal(classifyModel('deep-research-pro'), 'agent');
  assert.equal(classifyModel('agent-coder'), 'agent');
});

test('classifyModel routes decision models to decision', () => {
  assert.equal(classifyModel('gemini-decision'), 'decision');
  assert.equal(classifyModel('models/gemini-2.5-flash-decision'), 'decision');
});

test('classifyModel routes normal gemini models to chat', () => {
  assert.equal(classifyModel('gemini-2.5-flash'), 'chat');
  assert.equal(classifyModel('models/gemini-2.5-pro'), 'chat');
  assert.equal(classifyModel('gemini-3-flash-preview'), 'chat');
});

test('classifyModel respects explicit category override', () => {
  assert.equal(classifyModel('gemini-2.5-flash', 'decision'), 'decision');
  assert.equal(classifyModel('gemini-2.5-pro', 'agent'), 'agent');
});

test('stripModelsPrefix removes models/ prefix', () => {
  assert.equal(stripModelsPrefix('models/gemini-2.5-flash'), 'gemini-2.5-flash');
});
