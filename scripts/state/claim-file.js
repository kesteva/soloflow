#!/usr/bin/env node
'use strict';

// Soft owns_files contract — executor calls `claim-file.js add` when it
// discovers it needs to touch a file outside the plan's initial files_owned.
// The script consults all in-flight plans in the canonical .soloflow/
// (resolved via git common-dir, NOT the calling worktree's stale snapshot)
// and either grants atomically or denies with the conflicting task ID.
//
// Usage:
//   node claim-file.js add  <TASK-ID> <path>
//   node claim-file.js list <TASK-ID>
//
// Output (JSON):
//   add  → { ok: true,  files_owned: [...] }
//        | { ok: false, conflict_with: "TASK-NNN", path: "..." }
//   list → { task: "TASK-NNN", files_owned: [...] }
//
// All filesystem mutations occur under a process-wide file lock at
// <git-common-dir>/soloflow-claims.lock so concurrent claim attempts
// serialize cleanly.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const { withFileLock } = require('../lib/lock');
const { writeAtomic } = require('../lib/fs-atomic');

function die(msg, code = 1) {
  process.stderr.write(`claim-file: ${msg}\n`);
  process.exit(code);
}

function globPlanFiles(plansRoot) {
  const out = new Map();
  if (!fs.existsSync(plansRoot)) return out;
  const stack = [plansRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const m = e.name.match(/^TASK-(\d+)-plan\.md$/);
      if (m) out.set(`TASK-${m[1]}`, p);
    }
  }
  return out;
}

function readPlan(planPath) {
  const text = fs.readFileSync(planPath, 'utf8');
  return { text, ...yaml.splitFrontmatter(text) };
}

function normalizeRelPath(p, anchor) {
  if (path.isAbsolute(p)) return path.relative(anchor, p);
  return p;
}

// canonicalCwd resolves the working tree root that contains the canonical
// .soloflow/ — the main worktree's working dir, not the linked worktree
// that may be calling claim-file.js. We use --show-toplevel against the
// common gitdir so a linked worktree's main checkout is selected.
function canonicalCwd(cwd) {
  // commonGitDir returns the real .git/ path. Its parent is usually the
  // main worktree's root (when .git is a directory) or the worktree's
  // root when .git is a gitdir-link file inside .git/worktrees/<name>/.
  const common = paths.commonGitDir(cwd);
  // If the common path is .../.git, parent is the working tree root.
  if (path.basename(common) === '.git') return path.dirname(common);
  return cwd;
}

async function cmdAdd(taskId, claimPath) {
  if (!/^TASK-\d{3,}$/.test(taskId)) die(`invalid task ID: ${taskId}`);
  if (!claimPath) die('add requires a path');

  const callerCwd = process.cwd();
  const cwd = canonicalCwd(callerCwd);
  const lockPath = paths.claimsLockPath(callerCwd);

  const result = await withFileLock(lockPath, () => {
    const planByTask = globPlanFiles(path.join(paths.activeDir(cwd), 'plans'));
    const targetPath = planByTask.get(taskId);
    if (!targetPath) {
      return { ok: false, error: `no plan file for ${taskId} under canonical .soloflow/` };
    }

    const target = readPlan(targetPath);
    const targetFm = target.frontmatter || {};
    const targetOwned = Array.isArray(targetFm.files_owned) ? targetFm.files_owned.slice() : [];
    const normalized = normalizeRelPath(claimPath, cwd);

    // Already owned by caller — idempotent grant.
    if (targetOwned.includes(normalized)) {
      return { ok: true, files_owned: targetOwned, already_owned: true };
    }

    // Check every other in-flight plan for an overlap.
    for (const [otherId, otherPath] of planByTask) {
      if (otherId === taskId) continue;
      const other = readPlan(otherPath);
      const fm = other.frontmatter || {};
      if (fm.status !== 'in-flight') continue;
      const otherOwned = Array.isArray(fm.files_owned) ? fm.files_owned : [];
      if (otherOwned.includes(normalized)) {
        return { ok: false, conflict_with: otherId, path: normalized };
      }
    }

    // Grant: append to caller's files_owned and rewrite the plan atomically.
    targetOwned.push(normalized);
    const newFm = { ...targetFm, files_owned: targetOwned };
    writeAtomic(targetPath, yaml.joinFrontmatter(newFm, target.body));
    return { ok: true, files_owned: targetOwned };
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok && result.error) process.exit(2);
}

async function cmdList(taskId) {
  if (!/^TASK-\d{3,}$/.test(taskId)) die(`invalid task ID: ${taskId}`);
  const callerCwd = process.cwd();
  const cwd = canonicalCwd(callerCwd);
  const planByTask = globPlanFiles(path.join(paths.activeDir(cwd), 'plans'));
  const planPath = planByTask.get(taskId);
  if (!planPath) die(`no plan file for ${taskId}`);
  const fm = readPlan(planPath).frontmatter || {};
  const filesOwned = Array.isArray(fm.files_owned) ? fm.files_owned : [];
  process.stdout.write(JSON.stringify({ task: taskId, files_owned: filesOwned }, null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;
  if (!sub) die('usage: claim-file.js {add|list} ...');
  if (sub === 'add') {
    if (rest.length !== 2) die('usage: claim-file.js add <TASK-ID> <path>');
    await cmdAdd(rest[0], rest[1]);
  } else if (sub === 'list') {
    if (rest.length !== 1) die('usage: claim-file.js list <TASK-ID>');
    await cmdList(rest[0]);
  } else {
    die(`unknown subcommand: ${sub}`);
  }
}

main().catch((e) => die(e.message || String(e)));
