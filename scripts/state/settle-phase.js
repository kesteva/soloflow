#!/usr/bin/env node
'use strict';

// Sequential integrator for phase worktrees. Picks up every phase-ready/*
// branch, merges each in turn via phase-worktree-merge.js semantics, and
// reports outcomes. Conflicting branches are parked under
// phase-conflicted/* and surfaced for human review via the review queue.
//
// Behind the parallelism.phase_worktrees flag (default false). When the
// flag is off, the legacy direct-write paths are still used and this script
// is not invoked.
//
// Usage:
//   node settle-phase.js [--base-branch main] [--phase <phase>] [--id <id>]
//
// With no filters, processes every phase-ready/* branch.
// With --phase / --id, processes only the matching branch (delegates).

const path = require('path');
const { spawnSync } = require('child_process');
const { parse } = require('../lib/args');
const { git, tryGit, inRepo } = require('../lib/git');

function listPhaseReadyBranches(cwd) {
  const r = tryGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/phase-ready/'], { cwd });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean);
}

function parseBranch(branch) {
  const m = branch.match(/^phase-ready\/([^-]+)-(.+)$/);
  if (!m) return null;
  return { phase: m[1], id: m[2] };
}

function callPhaseMerge(cwd, phase, id, baseBranch) {
  const script = path.resolve(__dirname, 'phase-worktree-merge.js');
  const args = ['--phase', phase, '--id', id, '--base-branch', baseBranch];
  const r = spawnSync('node', [script, ...args], { cwd, encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* non-JSON failure */ }
  return { code: r.status, parsed, raw: r.stdout, err: r.stderr };
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const cwd = process.cwd();
  if (!inRepo(cwd)) {
    process.stderr.write('settle-phase: not inside a git work tree\n');
    process.exit(1);
  }

  let baseBranch = opts['base-branch'];
  if (!baseBranch) {
    const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (!r.ok) {
      process.stderr.write('settle-phase: HEAD detached and no --base-branch\n');
      process.exit(1);
    }
    baseBranch = r.out;
  }

  let branches = listPhaseReadyBranches(cwd);
  if (opts.phase || opts.id) {
    branches = branches.filter((b) => {
      const p = parseBranch(b);
      if (!p) return false;
      if (opts.phase && p.phase !== opts.phase) return false;
      if (opts.id && p.id !== opts.id) return false;
      return true;
    });
  }
  branches.sort();

  const results = [];
  let conflicted = 0;
  let merged = 0;
  for (const branch of branches) {
    const p = parseBranch(branch);
    if (!p) {
      results.push({ branch, error: 'unparseable branch name' });
      continue;
    }
    const r = callPhaseMerge(cwd, p.phase, p.id, baseBranch);
    if (r.code === 0 && r.parsed) {
      merged++;
      results.push({ branch, ...r.parsed });
    } else if (r.code === 2 && r.parsed) {
      conflicted++;
      results.push({ branch, ...r.parsed });
    } else {
      results.push({ branch, error: r.err || `unexpected exit code ${r.code}` });
    }
  }

  process.stdout.write(JSON.stringify({
    base_branch: baseBranch,
    branches_seen: branches.length,
    merged, conflicted,
    results,
  }, null, 2) + '\n');

  if (conflicted > 0) process.exit(2);
}

main();
