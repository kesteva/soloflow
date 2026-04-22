'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('findings: ensure-exists + append + set-status + reconcile', () => {
  const cwd = scaffold(mktmp());

  run('state/findings.js', ['ensure-exists', '--sprint', 'SPRINT-010'], { cwd });
  const p = path.join(cwd, '.soloflow/active/findings/SPRINT-010-findings.md');
  assert.ok(fs.existsSync(p));

  const a1 = JSON.parse(run('state/findings.js', ['append', '--sprint', 'SPRINT-010', '--fields-json',
    JSON.stringify({ source: 'TASK-001 (executor)', type: 'bug', severity: 'medium', status: 'open', location: 'a.ts:1', description: 'x', resolved_by: '' })
  ], { cwd }).out);
  assert.equal(a1.id, 'FIND-SPRINT-010-1');
  assert.equal(a1.pending_count, 1);

  const a2 = JSON.parse(run('state/findings.js', ['append', '--sprint', 'SPRINT-010', '--fields-json',
    JSON.stringify({ source: 'TASK-002 (executor)', type: 'cleanup', severity: 'low', status: 'open', location: 'b.ts:2', description: 'y', resolved_by: '' })
  ], { cwd }).out);
  assert.equal(a2.id, 'FIND-SPRINT-010-2');
  assert.equal(a2.pending_count, 2);

  const s = JSON.parse(run('state/findings.js', ['set-status', '--sprint', 'SPRINT-010', '--id', 'FIND-SPRINT-010-1', '--status', 'resolved', '--resolved-by', 'TASK-999'], { cwd }).out);
  assert.equal(s.pending_count, 1);
});

test('findings: reconcile from done report', () => {
  const cwd = scaffold(mktmp());
  run('state/findings.js', ['ensure-exists', '--sprint', 'SPRINT-011'], { cwd });
  run('state/findings.js', ['append', '--sprint', 'SPRINT-011', '--fields-json',
    JSON.stringify({ source: 'TASK-001 (executor)', type: 'bug', severity: 'low', status: 'open', location: 'a.ts', description: 'x', resolved_by: '' })
  ], { cwd });

  const drPath = path.join(cwd, '.soloflow/archive/done/TASK-005-done.md');
  fs.writeFileSync(drPath, `---\nid: TASK-005\nsprint: SPRINT-011\nstatus: done\n---\n\n## Status\n- **Findings resolved:** [FIND-SPRINT-011-1]\n`);

  const r = JSON.parse(run('state/findings.js', ['reconcile', '--sprint', 'SPRINT-011', '--from-done-report', drPath], { cwd }).out);
  assert.deepEqual(r.reconciled, ['FIND-SPRINT-011-1']);
  assert.equal(r.pending_count, 0);
});
