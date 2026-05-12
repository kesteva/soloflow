'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const { mktmp, scaffold, run } = require('./helpers');

function writeLegacySprint(cwd, sprintId, body = {}) {
  const p = path.join(cwd, '.soloflow/active/sprint.json');
  fs.writeFileSync(p, JSON.stringify({
    version: 2,
    sprint: { id: sprintId, status: 'active', started: '2026-04-22T00:00:00Z' },
    tasks: {},
    ...body,
  }, null, 2));
  return p;
}

test('migrate-002: dry-run prints planned move without mutating', () => {
  const cwd = scaffold(mktmp());
  writeLegacySprint(cwd, 'SPRINT-007');
  const r = run('migrations/migrate-002-per-sprint-sprint-json.js', [], { cwd });
  assert.equal(r.ok, true);
  const body = r.out.split('\n\n')[0];
  const summary = JSON.parse(body);
  assert.equal(summary.apply, false);
  assert.equal(summary.sprint_id, 'SPRINT-007');
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/active/sprint.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/active/sprints/SPRINT-007/sprint.json')), false);
});

test('migrate-002: --apply moves legacy sprint.json into per-sprint dir and stamps state-version', () => {
  const cwd = scaffold(mktmp());
  writeLegacySprint(cwd, 'SPRINT-007');
  const r = run('migrations/migrate-002-per-sprint-sprint-json.js', ['--apply'], { cwd });
  assert.equal(r.ok, true, r.err);

  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/active/sprint.json')), false);
  const newPath = path.join(cwd, '.soloflow/active/sprints/SPRINT-007/sprint.json');
  assert.equal(fs.existsSync(newPath), true);
  const moved = JSON.parse(fs.readFileSync(newPath, 'utf8'));
  assert.equal(moved.sprint.id, 'SPRINT-007');

  const stateVersion = yaml.parse(fs.readFileSync(path.join(cwd, '.soloflow/state-version'), 'utf8'));
  assert.ok(stateVersion.migrated_002);
});

test('migrate-002: idempotent — re-run after apply is a no-op', () => {
  const cwd = scaffold(mktmp());
  writeLegacySprint(cwd, 'SPRINT-007');
  run('migrations/migrate-002-per-sprint-sprint-json.js', ['--apply'], { cwd });
  const r = run('migrations/migrate-002-per-sprint-sprint-json.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  assert.match(r.out, /not present|already applied/);
});

test('migrate-002: missing legacy file is a clean no-op', () => {
  const cwd = scaffold(mktmp());
  const r = run('migrations/migrate-002-per-sprint-sprint-json.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  assert.match(r.out, /not present/);
});

test('migrate-002: errors out if legacy lacks sprint.id', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(path.join(cwd, '.soloflow/active/sprint.json'),
    JSON.stringify({ version: 2, sprint: null, tasks: {} }, null, 2));
  const r = run('migrations/migrate-002-per-sprint-sprint-json.js', ['--apply'], { cwd });
  assert.equal(r.ok, false);
  assert.match(r.err, /missing sprint\.id/);
});

test('migrate-002: skipped when target already exists', () => {
  const cwd = scaffold(mktmp());
  writeLegacySprint(cwd, 'SPRINT-007');
  fs.mkdirSync(path.join(cwd, '.soloflow/active/sprints/SPRINT-007'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/sprints/SPRINT-007/sprint.json'),
    JSON.stringify({ version: 2, sprint: { id: 'SPRINT-007', status: 'active' }, tasks: {} }),
  );
  const r = run('migrations/migrate-002-per-sprint-sprint-json.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  const summary = JSON.parse(r.out.split('\n\n')[0]);
  assert.match(summary.skipped_reason, /already exists/);
});
