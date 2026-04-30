#!/usr/bin/env node
'use strict';

// Create a phase-level git worktree for a long-running phase (planning,
// execution, compound, idea-refinement). Sibling of worktree-setup.js but
// for whole phases instead of per-task.
//
// Worktrees live at .soloflow-worktrees/<phase>-<id>/ (sibling of .soloflow/,
// gitignored) so they don't recursively contain .soloflow/.
//
// Usage:
//   node phase-worktree-setup.js --phase planning --id 042 [--base-branch <branch>]
//
// Output (JSON to stdout):
//   {
//     "phase":       "planning",
//     "id":          "042",
//     "worktree":    "/abs/path/.soloflow-worktrees/planning-042",
//     "branch":      "phase-ready/planning-042",
//     "base_branch": "main",
//     "base_sha":    "<short sha>"
//   }

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const { git, tryGit, inRepo } = require('../lib/git');
const paths = require('../lib/paths');

const VALID_PHASES = new Set(['planning', 'execution', 'compound', 'clarify']);

function main() {
  const { opts } = parse(process.argv.slice(2));
  const phase = opts.phase;
  const id = opts.id;
  if (!phase) die('phase-worktree-setup', '--phase is required (one of: ' + [...VALID_PHASES].join(', ') + ')');
  if (!VALID_PHASES.has(phase)) die('phase-worktree-setup', `unknown --phase: ${phase}`);
  if (!id) die('phase-worktree-setup', '--id is required');
  if (!/^[\w.-]+$/.test(id)) die('phase-worktree-setup', `invalid --id: ${id} (must be filename-safe)`);

  const cwd = process.cwd();
  if (!inRepo(cwd)) die('phase-worktree-setup', 'not inside a git work tree');

  let baseBranch = opts['base-branch'];
  if (!baseBranch) {
    const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (!r.ok) die('phase-worktree-setup', 'HEAD is detached and --base-branch not provided');
    baseBranch = r.out;
  }

  const wtPath = paths.phaseWorktreePath(cwd, phase, id);
  if (fs.existsSync(wtPath)) die('phase-worktree-setup', `phase worktree already exists at ${wtPath}`);

  const phaseBranch = `phase-ready/${phase}-${id}`;
  const branchExists = tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${phaseBranch}`], { cwd }).ok;
  if (branchExists) die('phase-worktree-setup', `branch ${phaseBranch} already exists; clean up before retrying`);

  fs.mkdirSync(paths.phaseWorktreesDir(cwd), { recursive: true });

  try {
    git(['worktree', 'add', '-b', phaseBranch, wtPath, baseBranch], { cwd });
  } catch (e) {
    die('phase-worktree-setup', `git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }

  const shaR = tryGit(['rev-parse', '--short', 'HEAD'], { cwd: wtPath });
  const baseSha = shaR.ok ? shaR.out : null;

  process.stdout.write(JSON.stringify({
    phase, id,
    worktree: path.resolve(wtPath),
    branch: phaseBranch,
    base_branch: baseBranch,
    base_sha: baseSha,
  }, null, 2) + '\n');
}

main();
