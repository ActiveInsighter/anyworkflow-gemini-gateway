import assert from 'node:assert/strict';
import test from 'node:test';
import { nextCronRun, parseCron } from '../src/schedule/cron.ts';

test('parseCron parses standard 5-field expressions', () => {
  const parsed = parseCron('*/15 9-18 * * 1-5');
  assert.deepEqual([...parsed.minutes], [0, 15, 30, 45]);
  assert.equal(parsed.hours.has(9), true);
  assert.equal(parsed.hours.has(18), true);
  assert.equal(parsed.hours.has(19), false);
  assert.equal(parsed.daysOfWeek.has(1), true);
  assert.equal(parsed.daysOfWeek.has(0), false);
});

test('nextCronRun computes next UTC-equivalent timestamp in Asia/Shanghai', () => {
  // 2026-11-19T01:50:00.000Z is 09:50 in Asia/Shanghai (UTC+8)
  const base = Date.parse('2026-11-19T01:50:00.000Z');
  const next = nextCronRun('0 10 * * *', 'Asia/Shanghai', base);
  // 10:00 Asia/Shanghai = 02:00 UTC
  assert.equal(next, '2026-11-19T02:00:00.000Z');
});
