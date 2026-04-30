'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const { mktmp, scaffold, run, writePlan } = require('./helpers');

function writeBacklog(cwd, tasks) {
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/backlog.json'),
    JSON.stringify({ version: 2, tasks }, null, 2),
  );
}

function readPlanFm(planPath) {
  return yaml.splitFrontmatter(fs.readFileSync(planPath, 'utf8')).frontmatter || {};
}

test('migrate-001: dry-run prints changes without mutating', () => {
  const cwd = scaffold(mktmp());
  const planPath = writePlan(cwd, 'TASK-001', { title: 'one' });
  writeBacklog(cwd, { 'TASK-001': { status: 'ready' } });

  const r = run('migrations/migrate-001-backlog-to-frontmatter.js', [], { cwd });
  assert.equal(r.ok, true);
  const body = r.out.split('\n\n')[0];
  const summary = JSON.parse(body);
  assert.equal(summary.apply, false);
  assert.equal(summary.plans_to_update, 1);

  const fm = readPlanFm(planPath);
  assert.equal(fm.status, undefined);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/active/backlog.json')), true);
});

test('migrate-001: --apply writes status and archives backlog', () => {
  const cwd = scaffold(mktmp());
  const planPath = writePlan(cwd, 'TASK-001', { title: 'one' });
  writePlan(cwd, 'TASK-002', { title: 'two' }, { epic: 'ep' });
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready' },
    'TASK-002': { status: 'deferred', deferred_at: '2026-04-01T00:00:00Z' },
  });

  const r = run('migrations/migrate-001-backlog-to-frontmatter.js', ['--apply'], { cwd });
  assert.equal(r.ok, true, r.err);

  assert.equal(readPlanFm(planPath).status, 'ready');
  const fm2 = readPlanFm(path.join(cwd, '.soloflow/active/plans/ep/TASK-002-plan.md'));
  assert.equal(fm2.status, 'deferred');
  assert.equal(fm2.deferred_at, '2026-04-01T00:00:00Z');

  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/active/backlog.json')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/archive/legacy/backlog.json')), true);

  const stateVersion = yaml.parse(fs.readFileSync(path.join(cwd, '.soloflow/state-version'), 'utf8'));
  assert.ok(stateVersion.migrated_001);
});

test('migrate-001: idempotent — re-run after apply is a no-op', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001');
  writeBacklog(cwd, { 'TASK-001': { status: 'ready' } });

  run('migrations/migrate-001-backlog-to-frontmatter.js', ['--apply'], { cwd });
  const r = run('migrations/migrate-001-backlog-to-frontmatter.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  assert.match(r.out, /not present|already applied/);
});

test('migrate-001: missing backlog.json is a clean no-op', () => {
  const cwd = scaffold(mktmp());
  // scaffold no longer creates backlog.json — already absent.
  const r = run('migrations/migrate-001-backlog-to-frontmatter.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  assert.match(r.out, /not present/);
});

test('migrate-001: backlog task without matching plan is skipped, not failing', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001');
  writeBacklog(cwd, {
    'TASK-001': { status: 'ready' },
    'TASK-099': { status: 'ready' }, // no plan on disk
  });
  const r = run('migrations/migrate-001-backlog-to-frontmatter.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);

  const summary = JSON.parse(r.out.split('\n\n')[0]);
  assert.equal(summary.plans_to_update, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.skipped_detail[0].id, 'TASK-099');
});

test('migrate-001: plan that already has matching frontmatter is skipped', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-001', { status: 'ready' });
  writeBacklog(cwd, { 'TASK-001': { status: 'ready' } });
  const r = run('migrations/migrate-001-backlog-to-frontmatter.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);

  const summary = JSON.parse(r.out.split('\n\n')[0]);
  assert.equal(summary.plans_to_update, 0);
  assert.equal(summary.skipped, 1);
  assert.match(summary.skipped_detail[0].reason, /already matches/);
});
