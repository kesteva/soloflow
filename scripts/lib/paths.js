'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

function stateRoot(cwd = process.cwd()) { return path.join(cwd, '.soloflow'); }
function activeDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'active'); }
function archiveDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'archive'); }

function sprintJsonPath(cwd = process.cwd()) { return path.join(activeDir(cwd), 'sprint.json'); }
function checkpointPath(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'checkpoint.md'); }
function reviewQueuePath(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'human-review-queue.md'); }

function findingsFilePath(sprintId, cwd = process.cwd()) {
  return path.join(activeDir(cwd), 'findings', `${sprintId}-findings.md`);
}

function worktreesDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'worktrees'); }
function taskWorktreePath(cwd, taskId) { return path.join(worktreesDir(cwd), taskId); }

// Common gitdir — single shared location even when called from a linked
// worktree. Used to anchor cross-worktree locks (claim-file, ID allocator).
// Falls back to <cwd>/.soloflow if not in a git repo, so tests that run
// outside a repo still have a deterministic lock location.
function commonGitDir(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return path.isAbsolute(out) ? out : path.resolve(cwd, out);
  } catch {
    return stateRoot(cwd);
  }
}

function claimsLockPath(cwd = process.cwd()) {
  return path.join(commonGitDir(cwd), 'soloflow-claims.lock');
}

function idAllocatorLockPath(cwd = process.cwd()) {
  return path.join(commonGitDir(cwd), 'soloflow-id-allocator.lock');
}

module.exports = {
  stateRoot, activeDir, archiveDir,
  sprintJsonPath, checkpointPath, reviewQueuePath,
  findingsFilePath,
  worktreesDir, taskWorktreePath,
  commonGitDir, claimsLockPath, idAllocatorLockPath,
};
