'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const yaml = require('../lib/yaml');
const { mktmp, scaffold, run, writePlan } = require('./helpers');

function readFm(planPath) {
  return yaml.splitFrontmatter(fs.readFileSync(planPath, 'utf8')).frontmatter || {};
}

test('set-plan-status: transitions ready → in-flight, preserves other fields', () => {
  const cwd = scaffold(mktmp());
  const planPath = writePlan(cwd, 'TASK-001', { status: 'ready', title: 't', depends_on: ['TASK-000'] });

  const r = run('state/set-plan-status.js', ['in-flight', 'TASK-001'], { cwd });
  assert.equal(r.ok, true, r.err);

  const summary = JSON.parse(r.out);
  assert.equal(summary.updated.length, 1);
  assert.equal(summary.updated[0].id, 'TASK-001');
  assert.equal(summary.updated[0].previous, 'ready');

  const fm = readFm(planPath);
  assert.equal(fm.status, 'in-flight');
  assert.equal(fm.title, 't');
  assert.deepEqual(fm.depends_on, ['TASK-000']);
});

test('set-plan-status: batch update across multiple plans', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  writePlan(cwd, 'TASK-002', { status: 'ready' }, { epic: 'auth' });
  writePlan(cwd, 'TASK-003', { status: 'deferred' });

  const r = run('state/set-plan-status.js', ['in-flight', 'TASK-001', 'TASK-002', 'TASK-003'], { cwd });
  assert.equal(r.ok, true, r.err);

  const summary = JSON.parse(r.out);
  assert.equal(summary.updated.length, 3);
  assert.equal(summary.skipped.length, 0);
});

test('set-plan-status: missing plan file is skipped, not an error', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  const r = run('state/set-plan-status.js', ['in-flight', 'TASK-001', 'TASK-099'], { cwd });
  assert.equal(r.ok, true, r.err);
  const summary = JSON.parse(r.out);
  assert.equal(summary.updated.length, 1);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.skipped[0].id, 'TASK-099');
});

test('set-plan-status: idempotent — re-running with same status is a skip', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'in-flight' });
  const r = run('state/set-plan-status.js', ['in-flight', 'TASK-001'], { cwd });
  assert.equal(r.ok, true, r.err);
  const summary = JSON.parse(r.out);
  assert.equal(summary.updated.length, 0);
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].reason, /already/);
});

test('set-plan-status: rejects invalid status value', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  const r = run('state/set-plan-status.js', ['frobnicated', 'TASK-001'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /invalid status/);
});

test('set-plan-status: rejects malformed task ID', () => {
  const cwd = scaffold(mktmp());
  const r = run('state/set-plan-status.js', ['ready', 'TASK-NOPE'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /invalid task ID/);
});
