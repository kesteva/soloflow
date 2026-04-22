'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('close-gather: tallies stats + reconciles findings', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: {
    'TASK-050': { status: 'blocked' },
  } });
  // sprint id is SPRINT-001 from helper.
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/TASK-010-done.md'),
    `---\nid: TASK-010\nsprint: SPRINT-001\nstatus: done\nsummary: "fixes"\nexecutor_loops: 1\ncode_review_rounds: 0\nvisual_mobile: pass\nvisual_web: not_applicable\n---\n\n- **Findings resolved:** [FIND-SPRINT-001-1]\n`);
  fs.writeFileSync(path.join(cwd, '.soloflow/active/findings/SPRINT-001-findings.md'),
    `---\nsprint: SPRINT-001\npending_count: 1\nlast_updated: null\n---\n\n# Findings Queue\n\n## FIND-SPRINT-001-1\n- **status:** open\n- **location:** x.ts\n`);

  const r = JSON.parse(run('sprint/close-gather.js', [], { cwd }).out);
  assert.equal(r.sprint.id, 'SPRINT-001');
  assert.equal(r.stats.completed_count, 1);
  assert.equal(r.stats.blocked_count, 1);
  assert.equal(r.stats.total_executor_loops, 1);
  assert.equal(r.stats.visual_coverage.per_task.mobile.pass, 1);
  assert.equal(r.findings_reconciliation.length, 1);
  assert.equal(r.findings_reconciliation[0].find_id, 'FIND-SPRINT-001-1');
  assert.equal(r.findings_reconciliation[0].resolved_by_task, 'TASK-010');
});
