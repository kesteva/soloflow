'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mktmp, run } = require('./helpers');

function initRepo(root) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['config', 'tag.gpgsign', 'false'], { cwd: root });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed'], { cwd: root });
}

test('sweep-processes: removes stale worktree dir, leaves preserved one', () => {
  const cwd = mktmp();
  initRepo(cwd);

  // Stale worktree: dir exists, no branch.
  fs.mkdirSync(path.join(cwd, '.soloflow/worktrees/TASK-001'), { recursive: true });

  // Preserved worktree: dir AND branch exist (simulates merge-conflict path).
  execFileSync('git', ['branch', 'main-TASK-002'], { cwd });
  fs.mkdirSync(path.join(cwd, '.soloflow/worktrees/TASK-002'), { recursive: true });

  const r = JSON.parse(run('sprint/sweep-processes.js', ['--base-branch', 'main'], { cwd }).out);
  assert.equal(r.base_branch, 'main');
  assert.equal(r.port_swept, null);
  assert.deepEqual(r.port_kills, []);

  const removedIds = r.removed_worktrees.map((w) => w.task_id);
  assert.deepEqual(removedIds, ['TASK-001']);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/worktrees/TASK-001')), false);

  const preservedIds = r.preserved_worktrees.map((w) => w.task_id);
  assert.deepEqual(preservedIds, ['TASK-002']);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/worktrees/TASK-002')), true);

  assert.equal(r.pruned, true);
});

test('sweep-processes: no-op when worktrees dir is absent', () => {
  const cwd = mktmp();
  initRepo(cwd);

  const r = JSON.parse(run('sprint/sweep-processes.js', ['--base-branch', 'main'], { cwd }).out);
  assert.deepEqual(r.removed_worktrees, []);
  assert.deepEqual(r.preserved_worktrees, []);
  assert.equal(r.pruned, true);
});

test('sweep-processes: port_swept reflects --port arg, no PIDs on unused port', () => {
  const cwd = mktmp();
  initRepo(cwd);

  // High, almost-certainly-unused port.
  const r = JSON.parse(run('sprint/sweep-processes.js', ['--port', '59387', '--base-branch', 'main'], { cwd }).out);
  assert.equal(r.port_swept, 59387);
  assert.deepEqual(r.port_kills, []);
});

test('sweep-processes: ignores non-TASK dirs under .soloflow/worktrees/', () => {
  const cwd = mktmp();
  initRepo(cwd);
  fs.mkdirSync(path.join(cwd, '.soloflow/worktrees/scratch'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.soloflow/worktrees/TASK-99'), { recursive: true }); // wrong format (2 digits)

  const r = JSON.parse(run('sprint/sweep-processes.js', ['--base-branch', 'main'], { cwd }).out);
  assert.deepEqual(r.removed_worktrees, []);
  assert.deepEqual(r.preserved_worktrees, []);
  // Both unmatched dirs remain on disk.
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/worktrees/scratch')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.soloflow/worktrees/TASK-99')), true);
});
