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

function expand(cwd, initial) {
  return run('sprint/expand-selection.js', ['--initial', initial.join(',')], { cwd });
}

test('expand-selection: forward — single dependent unblocked by selected task', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', depends_on: [] },
    'TASK-002': { status: 'ready', depends_on: [] },
    'TASK-003': { status: 'ready', depends_on: [] },
    'TASK-004': { status: 'ready', depends_on: [] },
    'TASK-005': { status: 'ready', depends_on: [] },
    'TASK-006': { status: 'ready', depends_on: ['TASK-003'] },
  });
  const r = expand(cwd, ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward, []);
  assert.deepEqual(data.added_forward, ['TASK-006']);
  assert.deepEqual(data.expanded, ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005', 'TASK-006']);
  assert.deepEqual(data.reasons['TASK-006'], { direction: 'forward', via: ['TASK-003'] });
});

test('expand-selection: backward — selected task pulls in its missing dep', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-005': { status: 'ready', depends_on: [] },
    'TASK-008': { status: 'ready', depends_on: ['TASK-005'] },
  });
  const r = expand(cwd, ['TASK-008']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward, ['TASK-005']);
  assert.deepEqual(data.added_forward, []);
  assert.deepEqual(data.expanded, ['TASK-005', 'TASK-008']);
  assert.deepEqual(data.reasons['TASK-005'], { direction: 'backward', via: ['TASK-008'] });
});

test('expand-selection: multi-level forward chain', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', depends_on: [] },
    'TASK-002': { status: 'ready', depends_on: ['TASK-001'] },
    'TASK-003': { status: 'ready', depends_on: ['TASK-002'] },
    'TASK-004': { status: 'ready', depends_on: ['TASK-003'] },
  });
  const r = expand(cwd, ['TASK-001']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward, []);
  assert.deepEqual(data.added_forward, ['TASK-002', 'TASK-003', 'TASK-004']);
  assert.deepEqual(data.expanded, ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004']);
});

test('expand-selection: multi-level backward chain', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', depends_on: [] },
    'TASK-002': { status: 'ready', depends_on: ['TASK-001'] },
    'TASK-003': { status: 'ready', depends_on: ['TASK-002'] },
    'TASK-004': { status: 'ready', depends_on: ['TASK-003'] },
  });
  const r = expand(cwd, ['TASK-004']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward.sort(), ['TASK-001', 'TASK-002', 'TASK-003']);
  assert.deepEqual(data.added_forward, []);
  assert.deepEqual(data.expanded, ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004']);
});

test('expand-selection: mixed — backward and forward in one closure', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', depends_on: [] },
    'TASK-002': { status: 'ready', depends_on: ['TASK-001'] },
    'TASK-003': { status: 'ready', depends_on: ['TASK-002'] },
    'TASK-004': { status: 'ready', depends_on: ['TASK-003'] },
  });
  const r = expand(cwd, ['TASK-003']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward.sort(), ['TASK-001', 'TASK-002']);
  assert.deepEqual(data.added_forward, ['TASK-004']);
  assert.deepEqual(data.expanded, ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004']);
  assert.equal(data.reasons['TASK-004'].direction, 'forward');
  assert.deepEqual(data.reasons['TASK-004'].via, ['TASK-003']);
});

test('expand-selection: forward does NOT pull in independent ready tasks', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', depends_on: [] },
    'TASK-007': { status: 'ready', depends_on: [] },
  });
  const r = expand(cwd, ['TASK-001']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_forward, []);
  assert.deepEqual(data.expanded, ['TASK-001']);
});

test('expand-selection: external dep (not in backlog) treated as satisfied; selection unchanged', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-002': { status: 'ready', depends_on: ['TASK-999'] },
  });
  const r = expand(cwd, ['TASK-002']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward, []);
  assert.deepEqual(data.added_forward, []);
  assert.deepEqual(data.expanded, ['TASK-002']);
});

test('expand-selection: deferred dep is not auto-pulled (only ready tasks expand)', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'deferred', depends_on: [] },
    'TASK-002': { status: 'ready', depends_on: ['TASK-001'] },
  });
  const r = expand(cwd, ['TASK-002']);
  assert.equal(r.ok, true, r.err);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.added_backward, []);
  assert.deepEqual(data.added_forward, []);
  assert.deepEqual(data.expanded, ['TASK-002']);
});

test('expand-selection: invalid initial id exits non-zero', () => {
  const cwd = scaffold(mktmp());
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready', depends_on: [] },
  });
  const r = expand(cwd, ['TASK-NOPE']);
  assert.equal(r.ok, false);
  assert.match(r.err, /TASK-NOPE/);
});
