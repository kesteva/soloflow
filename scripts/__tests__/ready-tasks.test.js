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
