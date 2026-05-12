'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('ready-tasks: respects depends_on + status', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: {
    'TASK-001': { status: 'done' },
    'TASK-002': { status: 'pending', depends_on: ['TASK-001'] },
    'TASK-003': { status: 'pending', depends_on: ['TASK-002'] },
    'TASK-004': { status: 'in_progress' },
    'TASK-005': { status: 'blocked' },
  } });
  const r = run('sprint/ready-tasks.js', [], { cwd });
  assert.equal(r.ok, true);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.ready, ['TASK-002']);
  assert.deepEqual(data.in_progress, ['TASK-004']);
  assert.ok(data.blocked['TASK-003']);
  assert.deepEqual(data.cycles, []);
});

test('ready-tasks: completed via flag', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: {
    'TASK-100': { status: 'pending', depends_on: ['TASK-001'] },
  } });
  const r = run('sprint/ready-tasks.js', ['--completed', 'TASK-001'], { cwd });
  const data = JSON.parse(r.out);
  assert.deepEqual(data.ready, ['TASK-100']);
});

test('ready-tasks: ignores completed sprint folders left behind by sprint-closer', () => {
  // Sprint-closer marks sprint.status = "complete" but leaves the folder in
  // active/sprints/. Without filtering, ready-tasks would die with "multiple
  // active sprints" once a second sprint is opened.
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintId: 'SPRINT-002',
    sprintTasks: { 'TASK-050': { status: 'pending' } },
  });
  // Add a previously-closed sprint folder.
  const closedDir = path.join(cwd, '.soloflow/active/sprints/SPRINT-001');
  fs.mkdirSync(closedDir, { recursive: true });
  fs.writeFileSync(path.join(closedDir, 'sprint.json'), JSON.stringify({
    version: 2,
    sprint: { id: 'SPRINT-001', status: 'complete', started: '2026-01-01T00:00:00Z' },
    tasks: {},
  }, null, 2));

  const r = run('sprint/ready-tasks.js', [], { cwd });
  assert.equal(r.ok, true, `expected success despite stale completed sprint, got err: ${r.err}`);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.ready, ['TASK-050']);
});
