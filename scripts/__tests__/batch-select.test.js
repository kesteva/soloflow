'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('batch-select: detects pending + respects archive coverage', () => {
  const cwd = scaffold(mktmp());
  // Three pending findings, but SPRINT-002 is covered by an archived proposal.
  for (const n of ['001', '002', '003']) {
    fs.writeFileSync(path.join(cwd, `.soloflow/active/findings/SPRINT-${n}-findings.md`), `---\nsprint: SPRINT-${n}\npending_count: 0\n---\n`);
  }
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/compound/SPRINT-002-proposal.md'), '---\n---\n');

  const r = JSON.parse(run('compound/batch-select.js', ['detect-pending'], { cwd }).out);
  assert.deepEqual(r.pending, ['SPRINT-001', 'SPRINT-003']);
});

test('batch-select: build-inputs derives span for non-contiguous batches', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(path.join(cwd, '.soloflow/active/findings/SPRINT-001-findings.md'), '---\n---\n');
  fs.writeFileSync(path.join(cwd, '.soloflow/active/findings/SPRINT-003-findings.md'), '---\n---\n');
  const r = JSON.parse(run('compound/batch-select.js', ['build-inputs', '--sprints', 'SPRINT-001,SPRINT-003'], { cwd }).out);
  assert.equal(r.span_label, 'SPRINT-001-003');
  assert.equal(r.proposal_basename, 'SPRINT-001-003-proposal.md');
  assert.equal(r.inputs.length, 2);
});
