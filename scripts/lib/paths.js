'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// SOLOFLOW_ROOT lets a parent process redirect every state read/write to a
// different repo root — used by the planner orchestrator to point all
// helpers at a phase worktree instead of the main checkout. When unset (the
// common case) we fall back to process.cwd() and behavior is unchanged.
//
// Phase-worktree machinery (phaseWorktreesDir, phaseWorktreePath) and
// shared lock paths (commonGitDir, claimsLockPath, idAllocatorLockPath) are
// deliberately NOT routed through this — they must anchor at the main repo
// (worktrees-of-worktrees would recurse) or auto-resolve via git
// (rev-parse --git-common-dir already returns the right shared path from
// inside any linked worktree).
function stateRootCwd() { return process.env.SOLOFLOW_ROOT || process.cwd(); }

function stateRoot(cwd = stateRootCwd()) { return path.join(cwd, '.soloflow'); }
function activeDir(cwd = stateRootCwd()) { return path.join(stateRoot(cwd), 'active'); }
function archiveDir(cwd = stateRootCwd()) { return path.join(stateRoot(cwd), 'archive'); }
function sprintsDir(cwd = stateRootCwd()) { return path.join(activeDir(cwd), 'sprints'); }

function sprintDirPath(cwd, sprintId) {
  if (!sprintId) throw new Error('sprintDirPath requires a sprintId');
  return path.join(sprintsDir(cwd), sprintId);
}
function sprintJsonPath(cwd, sprintId) {
  if (!sprintId) throw new Error('sprintJsonPath requires a sprintId — call findActiveSprintIds(cwd) first if you need to discover it');
  return path.join(sprintDirPath(cwd, sprintId), 'sprint.json');
}

// Pre-PR-3 layout. Used only by migrator-002 and the session-start banner.
function legacySprintJsonPath(cwd = stateRootCwd()) {
  return path.join(activeDir(cwd), 'sprint.json');
}

// Glob active/sprints/*/sprint.json and return metadata for sprints that are
// still in progress (sprint.status !== 'complete'). Sprint-closer marks the
// sprint complete in-place but leaves its folder under active/sprints/ so
// downstream consumers (compounder, ID allocator) can still read sprint.json
// — so this helper has to filter, not just glob. Sorted by id desc so the
// most recently-numbered sprint is first. Each entry's id is taken from the
// directory name (canonical) — sprint.json's `sprint.id` is expected to match
// but the directory name wins on disagreement.
function findActiveSprintIds(cwd = stateRootCwd()) {
  const root = sprintsDir(cwd);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sprintPath = path.join(root, entry.name, 'sprint.json');
    if (!fs.existsSync(sprintPath)) continue;
    let json = null;
    try { json = JSON.parse(fs.readFileSync(sprintPath, 'utf8')); } catch { /* skip malformed */ }
    const status = json && json.sprint ? json.sprint.status : null;
    if (status === 'complete') continue;
    out.push({
      id: entry.name,
      path: sprintPath,
      status,
      started: json && json.sprint ? json.sprint.started : null,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

// Lists every directory name under active/sprints/ regardless of status. Use
// this when you need the full sprint-folder set (e.g. ID allocation) and not
// `findActiveSprintIds`, which filters out completed sprints.
function listAllSprintFolders(cwd = stateRootCwd()) {
  const root = sprintsDir(cwd);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function checkpointPath(cwd = stateRootCwd()) { return path.join(stateRoot(cwd), 'checkpoint.md'); }
function reviewQueuePath(cwd = stateRootCwd()) { return path.join(stateRoot(cwd), 'human-review-queue.md'); }

function findingsFilePath(sprintId, cwd = stateRootCwd()) {
  return path.join(activeDir(cwd), 'findings', `${sprintId}-findings.md`);
}

function worktreesDir(cwd = stateRootCwd()) { return path.join(stateRoot(cwd), 'worktrees'); }
function taskWorktreePath(cwd, taskId) { return path.join(worktreesDir(cwd), taskId); }

// Phase worktrees live OUTSIDE .soloflow/ to avoid recursion (a worktree
// rooted at the same repo would contain its own .soloflow/, which contains
// its own worktrees/, ad infinitum). Sibling at repo root, gitignored.
function phaseWorktreesDir(cwd = process.cwd()) {
  return path.join(cwd, '.soloflow-worktrees');
}
function phaseWorktreePath(cwd, phase, id) {
  return path.join(phaseWorktreesDir(cwd), `${phase}-${id}`);
}

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
  stateRootCwd,
  stateRoot, activeDir, archiveDir,
  sprintsDir, sprintDirPath, sprintJsonPath, legacySprintJsonPath, findActiveSprintIds, listAllSprintFolders,
  checkpointPath, reviewQueuePath,
  findingsFilePath,
  worktreesDir, taskWorktreePath,
  phaseWorktreesDir, phaseWorktreePath,
  commonGitDir, claimsLockPath, idAllocatorLockPath,
};
