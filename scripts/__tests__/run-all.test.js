'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('run-all: fresh scaffold reports total_pending=0', () => {
  const cwd = scaffold(mktmp());
  const r = run('migrations/run-all.js', [], { cwd });
  assert.equal(r.ok, true, r.err);
  const summary = JSON.parse(r.out);
  assert.equal(summary.apply, false);
  assert.equal(summary.total_pending, 0);
  for (const m of summary.migrators) assert.equal(m.pending, false);
});

test('run-all: legacy backlog.json flips 001 to pending', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/backlog.json'),
    JSON.stringify({ version: 2, tasks: { 'TASK-001': { status: 'ready' } } }),
  );
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/plans/TASK-001-plan.md'),
    '---\nid: TASK-001\n---\n\nbody\n',
  );

  const r = run('migrations/run-all.js', [], { cwd });
  assert.equal(r.ok, true, r.err);
  const summary = JSON.parse(r.out);
  assert.equal(summary.total_pending, 1);
  const m001 = summary.migrators.find((m) => m.id.startsWith('001'));
  assert.equal(m001.pending, true);
  for (const m of summary.migrators) {
    if (m.id !== m001.id) assert.equal(m.pending, false);
  }
});

test('run-all: --apply runs pending migrators and re-runs are no-op', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/backlog.json'),
    JSON.stringify({ version: 2, tasks: { 'TASK-002': { status: 'deferred' } } }),
  );
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/plans/TASK-002-plan.md'),
    '---\nid: TASK-002\n---\n\nbody\n',
  );

  const r = run('migrations/run-all.js', ['--apply'], { cwd });
  assert.equal(r.ok, true, r.err);
  const summary = JSON.parse(r.out);
  assert.equal(summary.apply, true);
  const m001 = summary.applied.find((a) => a.id.startsWith('001'));
  assert.equal(m001.status, 'applied');
  // Backlog moved.
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/active/backlog.json')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/archive/legacy/backlog.json')), true);
  // Plan frontmatter status set.
  const text = fs.readFileSync(path.join(cwd, '.soloflow/active/plans/TASK-002-plan.md'), 'utf8');
  assert.match(text, /status:\s*deferred/);

  // Re-run: nothing pending.
  const r2 = run('migrations/run-all.js', [], { cwd });
  const summary2 = JSON.parse(r2.out);
  assert.equal(summary2.total_pending, 0);
});

test('run-all: stale IDEA without created stays no-op (migrate-004 skips unstamped is by-design)', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/ideas/IDEA-001.md'),
    '---\nid: IDEA-001\n---\n\nunstamped\n',
  );
  const r = run('migrations/run-all.js', [], { cwd });
  assert.equal(r.ok, true);
  const summary = JSON.parse(r.out);
  // 004 stamps unstamped IDEAs via mtime — pending=true on dry run, then applies.
  const m004 = summary.migrators.find((m) => m.id.startsWith('004'));
  assert.equal(m004.pending, true);

  const r2 = run('migrations/run-all.js', ['--apply'], { cwd });
  assert.equal(r2.ok, true);
  const summary2 = JSON.parse(r2.out);
  const a004 = summary2.applied.find((a) => a.id.startsWith('004'));
  assert.equal(a004.status, 'applied');
  // Now stamped — re-run is no-op.
  const r3 = run('migrations/run-all.js', [], { cwd });
  const summary3 = JSON.parse(r3.out);
  assert.equal(summary3.total_pending, 0);
});
