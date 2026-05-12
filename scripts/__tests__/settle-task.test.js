'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run, writePlan } = require('./helpers');

function readSprint(cwd, sprintId = 'SPRINT-001') {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.soloflow/active/sprints', sprintId, 'sprint.json'), 'utf8'));
}

function writeDoneReport(cwd, taskId) {
  const p = path.join(cwd, '.soloflow', 'archive', 'done', `${taskId}-done.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\nid: ${taskId}\n---\n\n# ${taskId} done\n`);
  return p;
}

function writeStuckReport(cwd, taskId) {
  const p = path.join(cwd, '.soloflow/active/stuck', `${taskId}-stuck.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `---\nid: ${taskId}\n---\n\n# ${taskId} stuck\n`);
  return p;
}

test('settle-task: done verdict removes task from sprint', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-010': { status: 'pending' } },
  });
  const donePath = writeDoneReport(cwd, 'TASK-010');

  const r = run('state/settle-task.js', ['TASK-010', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);

  assert.equal(readSprint(cwd).tasks['TASK-010'], undefined);
});

test('settle-task: stuck verdict sets status and verdict_at on the sprint task', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-014': { status: 'pending' } },
  });
  const stuckPath = writeStuckReport(cwd, 'TASK-014');

  const r = run('state/settle-task.js', ['TASK-014', 'stuck', '--stuck-report', stuckPath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);

  const t = readSprint(cwd).tasks['TASK-014'];
  assert.equal(t.status, 'stuck');
  assert.match(t.verdict_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('settle-task: done verdict requires --done-report', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-020': { status: 'pending' } },
  });
  const r = run('state/settle-task.js', ['TASK-020', 'done', '--no-commit'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /--done-report is required/);
});

test('settle-task: done verdict fails when done report does not exist', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-021': { status: 'pending' } },
  });
  const r = run('state/settle-task.js', ['TASK-021', 'done', '--done-report', '/nonexistent', '--no-commit'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /done report not found/);
});

test('settle-task: double-run on done task fails with not-found', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-015': { status: 'pending' } },
  });
  const donePath = writeDoneReport(cwd, 'TASK-015');

  const r1 = run('state/settle-task.js', ['TASK-015', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r1.ok, true);

  const r2 = run('state/settle-task.js', ['TASK-015', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r2.ok, false);
  assert.match(r2.err || '', /not found in active sprint/);
});

test('settle-task: missing sprint fails fast', () => {
  const cwd = scaffold(mktmp(), { withSprint: false });
  // No sprint dir at all — settle-task can't find any active sprint.
  const donePath = writeDoneReport(cwd, 'TASK-099');
  const r = run('state/settle-task.js', ['TASK-099', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /no active sprint/);
});

test('settle-task: done verdict deletes a flat plan file', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-030': { status: 'pending' } },
  });
  const planPath = writePlan(cwd, 'TASK-030', { status: 'in-flight' });
  const donePath = writeDoneReport(cwd, 'TASK-030');

  assert.equal(fs.existsSync(planPath), true);

  const r = run('state/settle-task.js', ['TASK-030', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
  assert.equal(fs.existsSync(planPath), false, 'plan file should be deleted');
});

test('settle-task: done verdict deletes an epic-nested plan file', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-031': { status: 'pending', epic: 'auth' } },
  });
  const planPath = writePlan(cwd, 'TASK-031', { status: 'in-flight' }, { epic: 'auth' });
  const donePath = writeDoneReport(cwd, 'TASK-031');

  assert.equal(fs.existsSync(planPath), true);
  assert.ok(planPath.includes('/auth/'), 'plan should be in epic subdir');

  const r = run('state/settle-task.js', ['TASK-031', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
  assert.equal(fs.existsSync(planPath), false, 'epic-nested plan file should be deleted');
});

test('settle-task: done verdict succeeds when no plan file exists', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-032': { status: 'pending' } },
  });
  const donePath = writeDoneReport(cwd, 'TASK-032');

  const r = run('state/settle-task.js', ['TASK-032', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
});

test('settle-task: done verdict errors when multiple plan files match the task ID', () => {
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-033': { status: 'pending' } },
  });
  writePlan(cwd, 'TASK-033', { status: 'in-flight' }, { epic: 'epic-a' });
  writePlan(cwd, 'TASK-033', { status: 'in-flight' }, { epic: 'epic-b' });
  const donePath = writeDoneReport(cwd, 'TASK-033');

  const r = run('state/settle-task.js', ['TASK-033', 'done', '--done-report', donePath, '--no-commit'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /multiple plan files found for TASK-033/);
});

test('settle-task: non-done verdicts leave the plan file in place', () => {
  for (const verdict of ['stuck', 'blocked', 'human_needed']) {
    const cwd = scaffold(mktmp(), {
      withSprint: true,
      sprintTasks: { 'TASK-034': { status: 'pending' } },
    });
    const planPath = writePlan(cwd, 'TASK-034', { status: 'in-flight' });
    const args = ['TASK-034', verdict, '--no-commit'];
    if (verdict === 'stuck') {
      const stuckPath = writeStuckReport(cwd, 'TASK-034');
      args.push('--stuck-report', stuckPath);
    }
    const r = run('state/settle-task.js', args, { cwd });
    assert.equal(r.ok, true, `expected success for ${verdict}, got err: ${r.err}`);
    assert.equal(fs.existsSync(planPath), true, `plan file should remain after ${verdict}`);
  }
});

test('settle-task: --touched paths are staged when committing', () => {
  // Smoke: --no-commit skips the git portion, but staging logic gates on
  // file existence — verify the verdict still succeeds with touched paths
  // present alongside the done report.
  const cwd = scaffold(mktmp(), {
    withSprint: true,
    sprintTasks: { 'TASK-016': { status: 'pending' } },
  });
  const donePath = writeDoneReport(cwd, 'TASK-016');
  const findingsPath = path.join(cwd, '.soloflow/active/findings/SPRINT-001-findings.md');
  fs.writeFileSync(findingsPath, '---\nsprint: SPRINT-001\n---\n\n# Findings Queue\n');

  const r = run('state/settle-task.js', [
    'TASK-016', 'done',
    '--done-report', donePath,
    '--touched', findingsPath,
    '--no-commit',
  ], { cwd });
  assert.equal(r.ok, true, `expected success, got err: ${r.err}`);
});
