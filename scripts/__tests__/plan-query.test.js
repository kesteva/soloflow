'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mktmp, scaffold, run, writePlan } = require('./helpers');

test('plan-query: filters by status', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready', title: 'a', epic: 'ep-1' });
  writePlan(cwd, 'TASK-002', { status: 'done', title: 'b' });
  writePlan(cwd, 'TASK-003', { status: 'ready', title: 'c', epic: 'ep-2' });
  const r = run('state/plan-query.js', ['--status', 'ready', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001\nTASK-003');
});

test('plan-query: filters by epic + plan-contains + projection', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready', title: 'hero' }, { epic: 'visual-audit-2026-04' });
  writePlan(cwd, 'TASK-002', { status: 'ready', title: 'nav' }, { epic: 'visual-audit-2026-04' });
  writePlan(cwd, 'TASK-003', { status: 'ready', title: 'footer' }, { epic: 'other' });
  const r = run('state/plan-query.js', [
    '--plan-contains', 'visual-audit-2026-04',
    '--fields', 'id,title,epic',
  ], { cwd });
  assert.equal(r.ok, true);
  const data = JSON.parse(r.out);
  assert.deepEqual(data, [
    { id: 'TASK-001', title: 'hero', epic: 'visual-audit-2026-04' },
    { id: 'TASK-002', title: 'nav', epic: 'visual-audit-2026-04' },
  ]);
});

test('plan-query: OR within --id, count format', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  writePlan(cwd, 'TASK-002', { status: 'ready' });
  writePlan(cwd, 'TASK-003', { status: 'ready' });
  const r = run('state/plan-query.js', ['--id', 'TASK-001', '--id', 'TASK-003', '--format', 'count'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, '2');
});

test('plan-query: AND across flags (status ∧ epic)', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' }, { epic: 'alpha' });
  writePlan(cwd, 'TASK-002', { status: 'done' }, { epic: 'alpha' });
  writePlan(cwd, 'TASK-003', { status: 'ready' }, { epic: 'beta' });
  const r = run('state/plan-query.js', ['--status', 'ready', '--epic', 'alpha', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001');
});

test('plan-query: empty match returns empty array / zero count / empty ids', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  const rJson = run('state/plan-query.js', ['--status', 'done'], { cwd });
  assert.equal(rJson.out, '[]');
  const rCount = run('state/plan-query.js', ['--status', 'done', '--format', 'count'], { cwd });
  assert.equal(rCount.out, '0');
  const rIds = run('state/plan-query.js', ['--status', 'done', '--format', 'ids'], { cwd });
  assert.equal(rIds.out, '');
});

test('plan-query: orphan plan (flat) is matched alongside epic plans', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  writePlan(cwd, 'TASK-002', { status: 'ready' }, { epic: 'ep' });
  const r = run('state/plan-query.js', ['--status', 'ready', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001\nTASK-002');
});

test('plan-query: missing frontmatter status excludes plan from --status filter', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  writePlan(cwd, 'TASK-002', {}); // no status field
  const r = run('state/plan-query.js', ['--status', 'ready', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001');
});

test('plan-query: synthetic plan_path is included when no --fields', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready', title: 't' });
  const r = run('state/plan-query.js', ['--status', 'ready'], { cwd });
  assert.equal(r.ok, true);
  const data = JSON.parse(r.out);
  assert.equal(data.length, 1);
  assert.equal(data[0].plan_path, '.soloflow/active/plans/TASK-001-plan.md');
});

test('plan-query: --plan-contains matches synthetic plan_path', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' }, { epic: 'visual-audit-2026-04' });
  writePlan(cwd, 'TASK-002', { status: 'ready' }, { epic: 'other' });
  const r = run('state/plan-query.js', ['--plan-contains', 'visual-audit', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001');
});
