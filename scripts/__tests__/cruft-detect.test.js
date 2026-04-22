'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('cruft-detect: orphan plan + mid-commit settle + empty epic', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: {
    // Mid-commit crash: done report exists AND task still in sprint.json.
    'TASK-010': { status: 'in_progress' },
  } });
  // Orphan plan: plan in active + done report in archive.
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/auth/TASK-005-plan.md'), '');
  fs.mkdirSync(path.join(cwd, '.soloflow/archive/done/auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/auth/TASK-005-done.md'), '');
  // Mid-commit: done for TASK-010.
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/TASK-010-done.md'), '');
  // Empty epic.
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/ghost-epic'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/ghost-epic/EPIC-ghost-epic.md'), '');

  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.orphan_plan.length, 1);
  assert.equal(r.orphan_plan[0].task_id, 'TASK-005');
  assert.equal(r.mid_commit_settle.length, 1);
  assert.equal(r.mid_commit_settle[0].task_id, 'TASK-010');
  assert.equal(r.empty_epic.length, 1);
  assert.equal(r.empty_epic[0].epic_slug, 'ghost-epic');
});
