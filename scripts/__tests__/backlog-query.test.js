'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

function writeBacklog(cwd, tasks) {
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/backlog.json'),
    JSON.stringify({ version: 2, tasks }, null, 2),
  );
}

test('backlog-query: filters by status', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', title: 'a', epic: 'ep-1' },
    'TASK-002': { status: 'done', title: 'b' },
    'TASK-003': { status: 'ready', title: 'c', epic: 'ep-2' },
  });
  const r = run('state/backlog-query.js', ['--status', 'ready', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001\nTASK-003');
});

test('backlog-query: filters by epic + plan-contains + projection', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', epic: 'visual-audit-2026-04', plan_path: '.soloflow/active/plans/visual-audit-2026-04/TASK-001-plan.md', title: 'hero' },
    'TASK-002': { status: 'ready', epic: 'visual-audit-2026-04', plan_path: '.soloflow/active/plans/visual-audit-2026-04/TASK-002-plan.md', title: 'nav' },
    'TASK-003': { status: 'ready', epic: 'other', plan_path: '.soloflow/active/plans/other/TASK-003-plan.md', title: 'footer' },
  });
  const r = run('state/backlog-query.js', [
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

test('backlog-query: OR within --id, count format', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready' },
    'TASK-002': { status: 'ready' },
    'TASK-003': { status: 'ready' },
  });
  const r = run('state/backlog-query.js', ['--id', 'TASK-001', '--id', 'TASK-003', '--format', 'count'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, '2');
});

test('backlog-query: AND across flags (status ∧ epic)', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', epic: 'alpha' },
    'TASK-002': { status: 'done', epic: 'alpha' },
    'TASK-003': { status: 'ready', epic: 'beta' },
  });
  const r = run('state/backlog-query.js', ['--status', 'ready', '--epic', 'alpha', '--format', 'ids'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-001');
});

test('backlog-query: --source sprint reads sprint.json', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: {
    'TASK-050': { status: 'in_progress', title: 'wip' },
    'TASK-051': { status: 'pending', title: 'queued' },
  } });
  const r = run('state/backlog-query.js', ['--source', 'sprint', '--status', 'in_progress', '--format', 'json'], { cwd });
  assert.equal(r.ok, true);
  const data = JSON.parse(r.out);
  assert.equal(data.length, 1);
  assert.equal(data[0].id, 'TASK-050');
  assert.equal(data[0].title, 'wip');
});

test('backlog-query: empty match returns empty array / zero count / empty ids', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, { 'TASK-001': { status: 'ready' } });
  const rJson = run('state/backlog-query.js', ['--status', 'done'], { cwd });
  assert.equal(rJson.out, '[]');
  const rCount = run('state/backlog-query.js', ['--status', 'done', '--format', 'count'], { cwd });
  assert.equal(rCount.out, '0');
  const rIds = run('state/backlog-query.js', ['--status', 'done', '--format', 'ids'], { cwd });
  assert.equal(rIds.out, '');
});

test('backlog-query: malformed tasks shape exits non-zero', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/backlog.json'),
    JSON.stringify({ version: 2, tasks: [] }, null, 2),
  );
  const r = run('state/backlog-query.js', ['--status', 'ready'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /missing tasks object/);
});
