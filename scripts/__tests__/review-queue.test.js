'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

function queuePath(cwd) { return path.join(cwd, '.soloflow/human-review-queue.md'); }

test('review-queue: append + gather + remove + override round-trip', () => {
  const cwd = scaffold(mktmp());

  // Append two.
  run('state/review-queue.js', ['append', '--entry-json',
    JSON.stringify({ task: 'TASK-001', type: 'action_required', action: 'Deploy', blocked_checks: ['check1'], level: 'ground_truth', severity: 'high' })
  ], { cwd });
  run('state/review-queue.js', ['append', '--entry-json',
    JSON.stringify({ task: 'TASK-002', type: 'action_required', action: 'Grant', blocked_checks: ['check2'], level: 'ground_truth', severity: 'medium' })
  ], { cwd });

  const gather = JSON.parse(run('state/review-queue.js', ['gather'], { cwd }).out);
  assert.equal(gather.pending_count, 2);
  assert.equal(gather.action_required.length, 2);

  // Override.
  const over = JSON.parse(run('state/review-queue.js', ['override', '--task', 'TASK-001', '--justification', 'not blocking'], { cwd }).out);
  assert.equal(over.overridden, 1);
  const g2 = JSON.parse(run('state/review-queue.js', ['gather'], { cwd }).out);
  assert.equal(g2.pending_count, 1);
  assert.equal(g2.overridden.length, 1);

  // Remove.
  const rem = JSON.parse(run('state/review-queue.js', ['remove', '--task', 'TASK-002'], { cwd }).out);
  assert.equal(rem.removed, 1);
  const g3 = JSON.parse(run('state/review-queue.js', ['gather'], { cwd }).out);
  assert.equal(g3.pending_count, 0);
});

test('review-queue: group-by action emits max severity', () => {
  const cwd = scaffold(mktmp());
  run('state/review-queue.js', ['append', '--entry-json',
    JSON.stringify({ task: 'TASK-001', type: 'action_required', action: 'Deploy', level: 'ground_truth', severity: 'medium' })
  ], { cwd });
  run('state/review-queue.js', ['append', '--entry-json',
    JSON.stringify({ task: 'TASK-002', type: 'action_required', action: 'Deploy', level: 'ground_truth', severity: 'high' })
  ], { cwd });
  const g = JSON.parse(run('state/review-queue.js', ['gather', '--group-by', 'action'], { cwd }).out);
  assert.equal(g.action_required_grouped.length, 1);
  assert.equal(g.action_required_grouped[0].severity, 'high');
  assert.deepEqual(g.action_required_grouped[0].task_ids.sort(), ['TASK-001', 'TASK-002']);
});
