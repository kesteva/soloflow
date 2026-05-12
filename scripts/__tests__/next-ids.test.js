'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { mktmp, scaffold, run } = require('./helpers');

test('next-ids: sprint from archive, active findings, and sprint.json', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/findings/SPRINT-001-findings.md'), '---\n---\n');
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/compound/SPRINT-002-proposal.md'), '---\n---\n');
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/compound/SPRINT-003-004-proposal.md'), '---\n---\n');
  const r = run('state/next-ids.js', ['--kind', 'sprint'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'SPRINT-005');
});

test('next-ids: sprint counts completed sprint folders left behind by sprint-closer', () => {
  // sprint-closer marks sprint.status = "complete" but leaves the folder in
  // active/sprints/. The allocator must still avoid colliding with those IDs
  // even after findActiveSprintIds filters them out.
  const cwd = scaffold(mktmp());
  for (const id of ['SPRINT-010', 'SPRINT-011']) {
    const dir = path.join(cwd, '.soloflow/active/sprints', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sprint.json'), JSON.stringify({
      version: 2,
      sprint: { id, status: 'complete', started: '2026-01-01T00:00:00Z' },
      tasks: {},
    }, null, 2));
  }
  const r = run('state/next-ids.js', ['--kind', 'sprint'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'SPRINT-012');
});

test('next-ids: task ID from plans / stuck / archive/done', () => {
  const cwd = scaffold(mktmp());
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/epicA'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/epicA/TASK-007-plan.md'), '');
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/TASK-003-done.md'), '');
  const r = run('state/next-ids.js', ['--kind', 'task'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-008');
});

test('next-ids: concurrent task allocators serialize through the lock', async () => {
  // The lock narrows the read-and-suggest race window. Two parallel callers
  // should both succeed and return well-formed IDs (the wx-write at the
  // caller is what enforces final uniqueness — the lock just keeps the
  // suggestion stable across the brief minting window).
  const cwd = scaffold(mktmp());
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/TASK-005-done.md'), '');

  const root = path.resolve(__dirname, '..', '..');
  const script = path.join(root, 'scripts', 'state', 'next-ids.js');

  function spawnAlloc() {
    return new Promise((resolve) => {
      const child = spawn('node', [script, '--kind', 'task'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (b) => { out += b.toString(); });
      child.on('close', (code) => resolve({ code, out: out.trim() }));
    });
  }

  const results = await Promise.all([spawnAlloc(), spawnAlloc(), spawnAlloc()]);
  for (const r of results) {
    assert.equal(r.code, 0);
    assert.match(r.out, /^TASK-\d{3}$/);
    assert.equal(r.out, 'TASK-006');
  }
});

test('next-ids: finding ID increments per sprint', () => {
  const cwd = scaffold(mktmp());
  const fp = path.join(cwd, '.soloflow/active/findings/SPRINT-005-findings.md');
  fs.writeFileSync(fp, `---
sprint: SPRINT-005
pending_count: 0
last_updated: null
---

# Findings Queue

## FIND-SPRINT-005-1
- **status:** open

## FIND-SPRINT-005-4
- **status:** resolved
`);
  const r = run('state/next-ids.js', ['--kind', 'finding', '--sprint', 'SPRINT-005'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'FIND-SPRINT-005-5');
});
