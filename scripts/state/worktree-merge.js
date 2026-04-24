#!/usr/bin/env node
'use strict';

// Finalize a per-task worktree created by worktree-setup.js.
//
// Usage:
//   node worktree-merge.js <TASK-ID> <outcome> [--base-branch <branch>]
//
// outcome ∈ { done, stuck, blocked, human_needed, abandon }
//
// Behavior:
// - done: merge the task branch into the base branch (ff-only; falls back to
//         non-ff merge if the base branch advanced; aborts with diagnostic
//         on conflict), then remove the worktree and delete the task branch.
// - any other outcome: remove the worktree and delete the task branch
//         (branch is force-deleted — the task's commits are discarded because
//         the outcome indicates the work should not land on the base branch).
//
// Output (JSON to stdout):
//   {
//     "task":        "TASK-NNN",
//     "outcome":     "done" | ...,
//     "merge":       "ff" | "non-ff" | "conflict" | null,
//     "head_sha":    "<short sha of base branch after op, or null>",
//     "error":       "<string, only present on failure>"
//   }
//
// Exit code: 0 on success (including clean-up path for non-done outcomes);
// non-zero only if the operation leaves state inconsistent (unresolved
// conflict on done, or worktree remove failure).

const fs = require('fs');
const { parse, die } = require('../lib/args');
const { git, tryGit, inRepo } = require('../lib/git');
const paths = require('../lib/paths');

const VALID = new Set(['done', 'stuck', 'blocked', 'human_needed', 'abandon']);

function removeWorktreeAndBranch(cwd, wtPath, taskBranch) {
  // Worktree remove; use --force to sweep .gitignored artifacts (test output, etc).
  const rm = tryGit(['worktree', 'remove', '--force', wtPath], { cwd });
  if (!rm.ok) {
    // Try pruning stale worktree metadata in case the dir was already gone.
    tryGit(['worktree', 'prune'], { cwd });
    if (fs.existsSync(wtPath)) return { ok: false, err: `worktree remove failed: ${rm.err}` };
  }
  tryGit(['branch', '-D', taskBranch], { cwd });
  return { ok: true };
}

function main() {
  const { opts, positional } = parse(process.argv.slice(2));
  if (positional.length !== 2) die('worktree-merge', 'usage: worktree-merge.js <TASK-ID> <outcome>');
  const [taskId, outcome] = positional;
  if (!/^TASK-\d{3,}$/.test(taskId)) die('worktree-merge', `invalid task ID: ${taskId}`);
  if (!VALID.has(outcome)) die('worktree-merge', `invalid outcome: ${outcome} (one of ${[...VALID].join(', ')})`);

  const cwd = process.cwd();
  if (!inRepo(cwd)) die('worktree-merge', 'not inside a git work tree');

  let baseBranch = opts['base-branch'];
  if (!baseBranch) {
    const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (!r.ok) die('worktree-merge', 'HEAD is detached and --base-branch not provided');
    baseBranch = r.out;
  }

  const wtPath = paths.taskWorktreePath(cwd, taskId);
  const taskBranch = `${baseBranch}-${taskId}`;

  const branchExists = tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${taskBranch}`], { cwd }).ok;

  if (outcome !== 'done') {
    const rm = removeWorktreeAndBranch(cwd, wtPath, taskBranch);
    if (!rm.ok) {
      process.stdout.write(JSON.stringify({ task: taskId, outcome, merge: null, head_sha: null, error: rm.err }, null, 2) + '\n');
      process.exit(1);
    }
    const head = tryGit(['rev-parse', '--short', baseBranch], { cwd });
    process.stdout.write(JSON.stringify({
      task: taskId, outcome, merge: null,
      head_sha: head.ok ? head.out : null,
    }, null, 2) + '\n');
    return;
  }

  // outcome === 'done'
  if (!branchExists) {
    die('worktree-merge', `task branch ${taskBranch} missing — nothing to merge`);
  }

  // Merge task branch into base branch. The orchestrator is expected to invoke
  // this from the main worktree checked out to baseBranch; verify.
  const curR = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  if (!curR.ok || curR.out !== baseBranch) {
    die('worktree-merge', `main worktree must be checked out to ${baseBranch} (currently: ${curR.ok ? curR.out : 'detached'})`);
  }

  let mergeMode = null;
  const ff = tryGit(['merge', '--ff-only', '--no-edit', taskBranch], { cwd });
  if (ff.ok) {
    mergeMode = 'ff';
  } else {
    // Fall back to non-ff merge. Safe when files_owned were disjoint because
    // the task branch and the advanced base branch touch non-overlapping files.
    const nonFf = tryGit(['merge', '--no-ff', '--no-edit', '-m', `merge(${taskId}): parallel task branch`, taskBranch], { cwd });
    if (nonFf.ok) {
      mergeMode = 'non-ff';
    } else {
      // Conflict. Abort the merge but preserve the worktree for inspection.
      tryGit(['merge', '--abort'], { cwd });
      process.stdout.write(JSON.stringify({
        task: taskId, outcome, merge: 'conflict', head_sha: null,
        error: `merge failed: ${nonFf.err}. Worktree preserved at ${wtPath} for inspection.`,
      }, null, 2) + '\n');
      process.exit(2);
    }
  }

  const rm = removeWorktreeAndBranch(cwd, wtPath, taskBranch);
  if (!rm.ok) {
    const head = tryGit(['rev-parse', '--short', baseBranch], { cwd });
    process.stdout.write(JSON.stringify({
      task: taskId, outcome, merge: mergeMode,
      head_sha: head.ok ? head.out : null,
      error: rm.err,
    }, null, 2) + '\n');
    process.exit(1);
  }

  const head = tryGit(['rev-parse', '--short', baseBranch], { cwd });
  process.stdout.write(JSON.stringify({
    task: taskId, outcome, merge: mergeMode,
    head_sha: head.ok ? head.out : null,
  }, null, 2) + '\n');
}

main();
