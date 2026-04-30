'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function stateRoot(cwd = process.cwd()) { return path.join(cwd, '.soloflow'); }
function activeDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'active'); }
function archiveDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'archive'); }
function sprintsDir(cwd = process.cwd()) { return path.join(activeDir(cwd), 'sprints'); }

function sprintDirPath(cwd, sprintId) {
  if (!sprintId) throw new Error('sprintDirPath requires a sprintId');
  return path.join(sprintsDir(cwd), sprintId);
}
function sprintJsonPath(cwd, sprintId) {
  if (!sprintId) throw new Error('sprintJsonPath requires a sprintId — call findActiveSprintIds(cwd) first if you need to discover it');
  return path.join(sprintDirPath(cwd, sprintId), 'sprint.json');
}

// Pre-PR-3 layout. Used only by migrator-002 and the session-start banner.
function legacySprintJsonPath(cwd = process.cwd()) {
  return path.join(activeDir(cwd), 'sprint.json');
}

// Glob active/sprints/*/sprint.json and return sprint metadata for each.
// Returns an array of { id, path, status, started } sorted by id desc so
// the most recently-numbered sprint is first. Each entry's id is taken
// from the directory name (canonical) — sprint.json's `sprint.id` is
// expected to match but the directory name wins on disagreement.
function findActiveSprintIds(cwd = process.cwd()) {
  const root = sprintsDir(cwd);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sprintPath = path.join(root, entry.name, 'sprint.json');
    if (!fs.existsSync(sprintPath)) continue;
    let json = null;
    try { json = JSON.parse(fs.readFileSync(sprintPath, 'utf8')); } catch { /* skip malformed */ }
    out.push({
      id: entry.name,
      path: sprintPath,
      status: json && json.sprint ? json.sprint.status : null,
      started: json && json.sprint ? json.sprint.started : null,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

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
  sprintsDir, sprintDirPath, sprintJsonPath, legacySprintJsonPath, findActiveSprintIds,
  checkpointPath, reviewQueuePath,
  findingsFilePath,
  worktreesDir, taskWorktreePath,
  commonGitDir, claimsLockPath, idAllocatorLockPath,
};
