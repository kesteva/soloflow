#!/usr/bin/env node
'use strict';

// Create a short-lived git worktree for a single parallel task, forked from
// the current HEAD of the run branch. The orchestrator injects the printed
// worktree path into each subagent's WORKTREE_ROOT directive.
//
// Usage:
//   node worktree-setup.js <TASK-ID> [--base-branch <branch>]
//
// Output (JSON to stdout):
//   {
//     "task":        "TASK-NNN",
//     "worktree":    "/abs/path/.soloflow/worktrees/TASK-NNN",
//     "branch":      "{base_branch}-TASK-NNN",
//     "base_branch": "{base_branch}",
//     "base_sha":    "<short sha>"
//   }
//
// Safety:
// - Aborts if the worktree path already exists.
// - Aborts if the task branch already exists (prevents clobbering a prior run).
// - Must be invoked from the main worktree (never from another worktree).

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const { git, tryGit, inRepo } = require('../lib/git');
const paths = require('../lib/paths');

function main() {
  const { opts, positional } = parse(process.argv.slice(2));
  if (positional.length !== 1) die('worktree-setup', 'usage: worktree-setup.js <TASK-ID> [--base-branch <branch>]');
  const taskId = positional[0];
  if (!/^TASK-\d{3,}$/.test(taskId)) die('worktree-setup', `invalid task ID: ${taskId}`);

  const cwd = process.cwd();
  if (!inRepo(cwd)) die('worktree-setup', 'not inside a git work tree');

  // Resolve base branch: explicit --base-branch wins, else current HEAD's branch.
  let baseBranch = opts['base-branch'];
  if (!baseBranch) {
    const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (!r.ok) die('worktree-setup', 'HEAD is detached and --base-branch not provided');
    baseBranch = r.out;
  }

  const wtPath = paths.taskWorktreePath(cwd, taskId);
  if (fs.existsSync(wtPath)) die('worktree-setup', `worktree already exists at ${wtPath}`);

  const taskBranch = `${baseBranch}-${taskId}`;
  const branchExists = tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${taskBranch}`], { cwd }).ok;
  if (branchExists) die('worktree-setup', `branch ${taskBranch} already exists; clean up before retrying`);

  fs.mkdirSync(paths.worktreesDir(cwd), { recursive: true });

  try {
    git(['worktree', 'add', '-b', taskBranch, wtPath, baseBranch], { cwd });
  } catch (e) {
    die('worktree-setup', `git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }

  const shaR = tryGit(['rev-parse', '--short', 'HEAD'], { cwd: wtPath });
  const baseSha = shaR.ok ? shaR.out : null;

  process.stdout.write(JSON.stringify({
    task: taskId,
    worktree: path.resolve(wtPath),
    branch: taskBranch,
    base_branch: baseBranch,
    base_sha: baseSha,
  }, null, 2) + '\n');
}

main();
