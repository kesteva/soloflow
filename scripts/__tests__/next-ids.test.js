'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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

test('next-ids: task ID from plans / stuck / archive/done', () => {
  const cwd = scaffold(mktmp());
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/epicA'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/epicA/TASK-007-plan.md'), '');
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/TASK-003-done.md'), '');
  const r = run('state/next-ids.js', ['--kind', 'task'], { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.out, 'TASK-008');
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
