'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const { mktmp, scaffold, run } = require('./helpers');

function readFm(p) {
  return yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter || {};
}

test('migrate-004: dry-run lists IDEAs to stamp without mutating', () => {
  const cwd = scaffold(mktmp());
  const ideaPath = path.join(cwd, '.soloflow/active/ideas/IDEA-001.md');
  fs.writeFileSync(ideaPath, '---\nid: IDEA-001\nstatus: deferred\n---\n\n# unstamped\n');
  const r = run('migrations/migrate-004-stale-idea-stamp.js', [], { cwd });
  assert.equal(r.ok, true);
  const summary = JSON.parse(r.out.split('\n\n')[0]);
  assert.equal(summary.apply, false);
  assert.equal(summary.stamped.length, 1);
  // No mutation in dry-run.
  assert.equal(readFm(ideaPath).created, undefined);
});

test('migrate-004: --apply backfills created via mtime', () => {
  const cwd = scaffold(mktmp());
  const ideaPath = path.join(cwd, '.soloflow/active/ideas/IDEA-001.md');
  fs.writeFileSync(ideaPath, '---\nid: IDEA-001\nstatus: deferred\n---\n\n# unstamped\n');
  const r = run('migrations/migrate-004-stale-idea-stamp.js', ['--apply'], { cwd });
  assert.equal(r.ok, true, r.err);
  const fm = readFm(ideaPath);
  assert.match(fm.created, /^\d{4}-\d{2}-\d{2}T/);
});

test('migrate-004: skips IDEAs that already have created field', () => {
  const cwd = scaffold(mktmp());
  const ideaPath = path.join(cwd, '.soloflow/active/ideas/IDEA-001.md');
  fs.writeFileSync(ideaPath, '---\nid: IDEA-001\nstatus: deferred\ncreated: 2026-01-01T00:00:00Z\n---\n\n# stamped\n');
  const r = run('migrations/migrate-004-stale-idea-stamp.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  const summary = JSON.parse(r.out.split('\n\n')[0]);
  assert.equal(summary.stamped.length, 0);
  assert.equal(summary.skipped.length, 1);
  // Original timestamp preserved.
  assert.equal(readFm(ideaPath).created, '2026-01-01T00:00:00Z');
});

test('migrate-004: missing ideas dir is a clean no-op', () => {
  const cwd = scaffold(mktmp());
  fs.rmSync(path.join(cwd, '.soloflow/active/ideas'), { recursive: true, force: true });
  const r = run('migrations/migrate-004-stale-idea-stamp.js', ['--apply'], { cwd });
  assert.equal(r.ok, true);
  assert.match(r.out, /no active\/ideas/);
});
