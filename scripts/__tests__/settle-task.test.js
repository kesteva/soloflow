'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

function writeBacklog(cwd, tasks) {
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/backlog.json'),
    JSON.stringify({ version: 2, tasks }, null, 2) + '\n',
  );
}

function readBacklog(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.soloflow/active/backlog.json'), 'utf8'));
}

function readSprint(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.soloflow/active/sprint.json'), 'utf8'));
}

function writeDoneReport(cwd, taskId) {
  const p = path.join(cwd, '.soloflow', 'archive', 'done', `${taskId}-done.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\nid: ${taskId}\n---\n\n# ${taskId} done\n`);
  return p;
}

test('settle-task: done verdict removes task from sprint AND backlog', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-010': { status: 'pending' } },
  });
  writeBacklog(cwd, { 'TASK-010': { status: 'ready', depends_on: [] } });
  const donePath = writeDoneReport(cwd, 'TASK-010');

  const r = run('state/settle-task.js', ['TASK-010', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);

  assert.equal(readSprint(cwd).tasks['TASK-010'], undefined);
  assert.equal(readBacklog(cwd).tasks['TASK-010'], undefined);
});

test('settle-task: done verdict is a no-op on backlog when task is absent', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-011': { status: 'pending' } },
  });
  writeBacklog(cwd, { 'TASK-OTHER': { status: 'ready' } });
  const donePath = writeDoneReport(cwd, 'TASK-011');

  const before = fs.readFileSync(path.join(cwd, '.soloflow/active/backlog.json'), 'utf8');
  const r = run('state/settle-task.js', ['TASK-011', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true);
  const after = fs.readFileSync(path.join(cwd, '.soloflow/active/backlog.json'), 'utf8');
  assert.equal(after, before, 'backlog.json should be byte-identical when task absent');
});

test('settle-task: done verdict succeeds when backlog.json is missing', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-012': { status: 'pending' } },
  });
  fs.unlinkSync(path.join(cwd, '.soloflow/active/backlog.json'));
  const donePath = writeDoneReport(cwd, 'TASK-012');

  const r = run('state/settle-task.js', ['TASK-012', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
  assert.equal(readSprint(cwd).tasks['TASK-012'], undefined);
});

test('settle-task: done verdict warns but succeeds when backlog.json is corrupt', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-013': { status: 'pending' } },
  });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/backlog.json'), '{not valid json');
  const donePath = writeDoneReport(cwd, 'TASK-013');

  const r = run('state/settle-task.js', ['TASK-013', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
  assert.equal(readSprint(cwd).tasks['TASK-013'], undefined);
  assert.match(r.err || '', /skipping backlog scrub/);
});

test('settle-task: stuck verdict does NOT touch backlog.json', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-014': { status: 'pending' } },
  });
  // Pathological state: task somehow present in both. Stuck should leave backlog alone.
  writeBacklog(cwd, { 'TASK-014': { status: 'ready' } });
  const stuckPath = path.join(cwd, '.soloflow/active/stuck/TASK-014-stuck.md');
  fs.mkdirSync(path.dirname(stuckPath), { recursive: true });
  fs.writeFileSync(stuckPath, `---\nid: TASK-014\n---\n\nstuck\n`);

  const before = fs.readFileSync(path.join(cwd, '.soloflow/active/backlog.json'), 'utf8');
  const r = run('state/settle-task.js', ['TASK-014', 'stuck', '--stuck-report', stuckPath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
  const after = fs.readFileSync(path.join(cwd, '.soloflow/active/backlog.json'), 'utf8');
  assert.equal(after, before, 'stuck verdict must not touch backlog.json');
  assert.equal(readSprint(cwd).tasks['TASK-014'].status, 'stuck');
});

test('settle-task: double-run on done task fails with not-found; backlog stays scrubbed', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-015': { status: 'pending' } },
  });
  writeBacklog(cwd, { 'TASK-015': { status: 'ready' } });
  const donePath = writeDoneReport(cwd, 'TASK-015');

  const r1 = run('state/settle-task.js', ['TASK-015', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r1.ok, true);
  assert.equal(readBacklog(cwd).tasks['TASK-015'], undefined);

  const r2 = run('state/settle-task.js', ['TASK-015', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r2.ok, false);
  assert.match(r2.err || '', /not found in active sprint/);
  assert.equal(readBacklog(cwd).tasks['TASK-015'], undefined);
});
