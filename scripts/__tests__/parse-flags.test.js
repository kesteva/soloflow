'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mktmp, scaffold, run } = require('./helpers');

test('parse-flags: --quick disables everything', () => {
  const cwd = scaffold(mktmp());
  const r = run('sprint/parse-flags.js', ['--args', 'TASK-001 --quick'], { cwd });
  assert.equal(r.ok, true);
  const data = JSON.parse(r.out);
  assert.deepEqual(data.positional, ['TASK-001']);
  assert.equal(data.effective.per_task_verification_enabled, false);
  assert.equal(data.effective.per_task_code_review_enabled, false);
  assert.equal(data.effective.sprint_verification_enabled, false);
  assert.equal(data.effective.sprint_code_review_enabled, false);
});

test('parse-flags: unknown flag exits non-zero with JSON error', () => {
  const cwd = scaffold(mktmp());
  const r = run('sprint/parse-flags.js', ['--args', '--no-codereview'], { cwd });
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  const data = JSON.parse(r.out);
  assert.match(data.error, /Unknown flag/);
});

test('parse-flags: --no-code-review only touches code-review booleans', () => {
  const cwd = scaffold(mktmp());
  const r = run('sprint/parse-flags.js', ['--args', 'IDEA-001 --no-code-review'], { cwd });
  const data = JSON.parse(r.out);
  assert.equal(data.effective.per_task_verification_enabled, true);
  assert.equal(data.effective.per_task_code_review_enabled, false);
});
