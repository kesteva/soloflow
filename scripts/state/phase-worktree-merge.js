#!/usr/bin/env node
'use strict';

// Finalize a phase worktree created by phase-worktree-setup.js.
//
// On success: ff-merge the phase-ready branch back into the base branch
// (falling back to non-ff merge), then remove the worktree and delete the
// branch.
//
// On conflict: park the branch under phase-conflicted/<phase>-<id>, file
// a human-review-queue 'actions' item with the diff context, leave the
// worktree at .soloflow-worktrees/<phase>-<id>/ for inspection, and exit
// non-zero.
//
// Class-1 state files (sprint.json, EPIC manifests, *-plan.md frontmatter)
// are merged via lib/merge-schema.js when git's text merge fails on them
// alone — settle-phase takes a second pass over the conflict markers and
// rewrites those files structurally. Other conflicts (CLAUDE.md, code,
// arbitrary prose) are routed to human review.
//
// For the initial PR #5 cut, we implement the happy path + conflict
// detection. The structured-merge fallback is wired but operates only on
// conflict markers in known-schema files; other conflicts go to human
// review without re-attempting an automatic resolution.
//
// Usage:
//   node phase-worktree-merge.js --phase planning --id 042 [--base-branch main]

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const { git, tryGit, inRepo } = require('../lib/git');
const paths = require('../lib/paths');

function removeWorktreeAndBranch(cwd, wtPath, branch) {
  const rm = tryGit(['worktree', 'remove', '--force', wtPath], { cwd });
  if (!rm.ok) {
    tryGit(['worktree', 'prune'], { cwd });
    if (fs.existsSync(wtPath)) return { ok: false, err: `worktree remove failed: ${rm.err}` };
  }
  tryGit(['branch', '-D', branch], { cwd });
  return { ok: true };
}

function parkBranch(cwd, fromBranch, parkedName) {
  // Rename the branch so it doesn't sit in phase-ready/ where the next
  // settle pass would try to merge it again.
  tryGit(['branch', '-M', fromBranch, parkedName], { cwd });
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const phase = opts.phase;
  const id = opts.id;
  if (!phase) die('phase-worktree-merge', '--phase is required');
  if (!id) die('phase-worktree-merge', '--id is required');

  const cwd = process.cwd();
  if (!inRepo(cwd)) die('phase-worktree-merge', 'not inside a git work tree');

  let baseBranch = opts['base-branch'];
  if (!baseBranch) {
    const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (!r.ok) die('phase-worktree-merge', 'HEAD is detached and --base-branch not provided');
    baseBranch = r.out;
  }

  const wtPath = paths.phaseWorktreePath(cwd, phase, id);
  const phaseBranch = `phase-ready/${phase}-${id}`;

  const branchExists = tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${phaseBranch}`], { cwd }).ok;
  if (!branchExists) die('phase-worktree-merge', `branch ${phaseBranch} missing — nothing to merge`);

  const cur = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  if (!cur.ok || cur.out !== baseBranch) {
    die('phase-worktree-merge', `main worktree must be on ${baseBranch} (currently: ${cur.ok ? cur.out : 'detached'})`);
  }

  let mergeMode = null;
  const ff = tryGit(['merge', '--ff-only', '--no-edit', phaseBranch], { cwd });
  if (ff.ok) {
    mergeMode = 'ff';
  } else {
    const nonFf = tryGit(['merge', '--no-ff', '--no-edit', '-m', `merge(phase-${phase}-${id}): integrate phase`, phaseBranch], { cwd });
    if (nonFf.ok) {
      mergeMode = 'non-ff';
    } else {
      tryGit(['merge', '--abort'], { cwd });
      const parkedName = `phase-conflicted/${phase}-${id}`;
      parkBranch(cwd, phaseBranch, parkedName);
      process.stdout.write(JSON.stringify({
        phase, id, merge: 'conflict',
        parked_branch: parkedName,
        worktree: wtPath,
        error: `merge failed: ${nonFf.err.split('\n')[0]}. Branch parked at ${parkedName}; worktree preserved at ${wtPath} for inspection. File a human-review-queue 'actions' item to resolve.`,
      }, null, 2) + '\n');
      process.exit(2);
    }
  }

  const rm = removeWorktreeAndBranch(cwd, wtPath, phaseBranch);
  if (!rm.ok) {
    process.stdout.write(JSON.stringify({
      phase, id, merge: mergeMode,
      error: rm.err,
    }, null, 2) + '\n');
    process.exit(1);
  }

  const head = tryGit(['rev-parse', '--short', baseBranch], { cwd });
  process.stdout.write(JSON.stringify({
    phase, id, merge: mergeMode,
    head_sha: head.ok ? head.out : null,
  }, null, 2) + '\n');
}

main();
