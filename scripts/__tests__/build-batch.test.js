'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

function writePlan(cwd, taskId, filesOwned, { epic } = {}) {
  const dir = epic
    ? path.join(cwd, '.soloflow/active/plans', epic)
    : path.join(cwd, '.soloflow/active/plans');
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `id: ${taskId}`,
    'status: approved',
    epic ? `epic: ${epic}` : 'epic: null',
    'files_owned:',
    ...filesOwned.map((f) => `  - ${f}`),
    '---',
    '# body',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${taskId}-plan.md`), fm);
}

test('build-batch: three disjoint tasks pack into one batch', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/a.ts']);
  writePlan(cwd, 'TASK-002', ['src/b.ts']);
  writePlan(cwd, 'TASK-003', ['src/c.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002,TASK-003'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001', 'TASK-002', 'TASK-003']);
  assert.deepEqual(r.deferred, []);
});

test('build-batch: overlap defers second conflicting task', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/shared.ts', 'src/a.ts']);
  writePlan(cwd, 'TASK-002', ['src/shared.ts']);
  writePlan(cwd, 'TASK-003', ['src/c.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002,TASK-003'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001', 'TASK-003']);
  assert.deepEqual(r.deferred, ['TASK-002']);
  assert.match(r.reasons['TASK-002'], /^overlap:src\/shared\.ts:TASK-001$/);
});

test('build-batch: respects --max cap', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/a.ts']);
  writePlan(cwd, 'TASK-002', ['src/b.ts']);
  writePlan(cwd, 'TASK-003', ['src/c.ts']);
  writePlan(cwd, 'TASK-004', ['src/d.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002,TASK-003,TASK-004', '--max', '2'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001', 'TASK-002']);
  assert.deepEqual(r.deferred, ['TASK-003', 'TASK-004']);
  assert.equal(r.reasons['TASK-003'], 'batch-cap');
  assert.equal(r.reasons['TASK-004'], 'batch-cap');
});

test('build-batch: empty files_owned runs solo', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', []);
  writePlan(cwd, 'TASK-002', ['src/b.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001']);
  assert.deepEqual(r.deferred, ['TASK-002']);
});

test('build-batch: empty files_owned in second slot is deferred', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/a.ts']);
  writePlan(cwd, 'TASK-002', []);
  writePlan(cwd, 'TASK-003', ['src/c.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002,TASK-003'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001', 'TASK-003']);
  assert.deepEqual(r.deferred, ['TASK-002']);
  assert.equal(r.reasons['TASK-002'], 'empty-files-owned-needs-solo');
});

test('build-batch: finds plan in nested epic folder', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/a.ts'], { epic: 'auth-rewrite' });
  writePlan(cwd, 'TASK-002', ['src/b.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001', 'TASK-002']);
});

test('build-batch: missing plan is deferred with no-plan-file reason', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/a.ts']);
  // TASK-002 has no plan file
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001']);
  assert.deepEqual(r.deferred, ['TASK-002']);
  assert.equal(r.reasons['TASK-002'], 'no-plan-file');
});

test('build-batch: empty ready list produces empty output', () => {
  const cwd = scaffold(mktmp());
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', ''], { cwd }).out);
  assert.deepEqual(r.batch, []);
  assert.deepEqual(r.deferred, []);
});

test('build-batch: --max 1 forces serial behavior', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', ['src/a.ts']);
  writePlan(cwd, 'TASK-002', ['src/b.ts']);
  writePlan(cwd, 'TASK-003', ['src/c.ts']);
  const r = JSON.parse(run('sprint/build-batch.js', ['--ready', 'TASK-001,TASK-002,TASK-003', '--max', '1'], { cwd }).out);
  assert.deepEqual(r.batch, ['TASK-001']);
  assert.deepEqual(r.deferred, ['TASK-002', 'TASK-003']);
});
