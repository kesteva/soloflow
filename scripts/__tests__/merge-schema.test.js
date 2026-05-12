'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ms = require('../state/lib/merge-schema');

test('merge-schema: maxStatus respects plan-status precedence (done > in-flight > ready > deferred)', () => {
  assert.equal(ms.maxStatus('ready', 'in-flight'), 'in-flight');
  assert.equal(ms.maxStatus('in-flight', 'done'), 'done');
  assert.equal(ms.maxStatus('done', 'ready'), 'done');
  assert.equal(ms.maxStatus('deferred', 'ready'), 'ready');
  assert.equal(ms.maxStatus('ready', 'ready'), 'ready');
});

test('merge-schema: unionScalars dedupes preserving first-seen order', () => {
  assert.deepEqual(ms.unionScalars([['a', 'b'], ['b', 'c'], ['a', 'd']]), ['a', 'b', 'c', 'd']);
});

test('merge-schema: mergePlanFrontmatter takes max status, unions list fields', () => {
  const a = { id: 'TASK-001', status: 'ready', files_owned: ['a.js'], depends_on: ['TASK-000'] };
  const b = { id: 'TASK-001', status: 'in-flight', files_owned: ['b.js'], depends_on: ['TASK-000'] };
  const merged = ms.mergePlanFrontmatter([a, b]);
  assert.equal(merged.status, 'in-flight');
  assert.deepEqual(merged.files_owned.sort(), ['a.js', 'b.js']);
  assert.deepEqual(merged.depends_on, ['TASK-000']);
});

test('merge-schema: mergePlanFrontmatter — done wins over in-flight regardless of order', () => {
  const a = { status: 'in-flight' };
  const b = { status: 'done' };
  assert.equal(ms.mergePlanFrontmatter([a, b]).status, 'done');
  assert.equal(ms.mergePlanFrontmatter([b, a]).status, 'done');
});

test('merge-schema: mergeSprintJson — status: complete wins over active', () => {
  const a = { sprint: { id: 'SPRINT-001', status: 'active' }, tasks: { 'TASK-001': { status: 'in_progress' } } };
  const b = { sprint: { id: 'SPRINT-001', status: 'complete' }, tasks: { 'TASK-001': { status: 'done' } } };
  const merged = ms.mergeSprintJson([a, b]);
  assert.equal(merged.sprint.status, 'complete');
  assert.equal(merged.tasks['TASK-001'].status, 'done');
});

test('merge-schema: mergeSprintJson — task statuses follow precedence (done > stuck > in_progress > pending)', () => {
  const a = { tasks: { 'TASK-001': { status: 'pending' }, 'TASK-002': { status: 'stuck' } } };
  const b = { tasks: { 'TASK-001': { status: 'done' }, 'TASK-002': { status: 'in_progress' } } };
  const merged = ms.mergeSprintJson([a, b]);
  assert.equal(merged.tasks['TASK-001'].status, 'done');
  assert.equal(merged.tasks['TASK-002'].status, 'stuck');
});

test('merge-schema: maxTimestamp picks the later ISO string', () => {
  assert.equal(
    ms.maxTimestamp('2026-04-01T00:00:00Z', '2026-04-22T00:00:00Z'),
    '2026-04-22T00:00:00Z'
  );
  assert.equal(ms.maxTimestamp(null, '2026-01-01T00:00:00Z'), '2026-01-01T00:00:00Z');
  assert.equal(ms.maxTimestamp('2026-01-01T00:00:00Z', null), '2026-01-01T00:00:00Z');
});

test('merge-schema: mergePlanFile preserves body from first non-empty source', () => {
  const a = { frontmatter: { status: 'ready' }, body: '' };
  const b = { frontmatter: { status: 'in-flight' }, body: '# Body content\n' };
  const merged = ms.mergePlanFile([a, b]);
  assert.equal(merged.body, '# Body content\n');
  assert.equal(merged.frontmatter.status, 'in-flight');
});
