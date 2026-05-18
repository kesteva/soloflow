#!/usr/bin/env node
'use strict';

// Sweep stragglers and stale per-task worktrees at sprint close.
//
// Sprint-closer's finalize phase invokes this after the close commit lands.
// Defensive cleanup that complements the orchestrator's TaskStop on tracked
// harness shells:
//
//   - Port sweep: lsof-kill any PIDs holding the dev-server probe port.
//     Covers the case where dev_server.task_id was lost (e.g. session
//     restart) or the harness shell wandered off the tracked task.
//   - Worktree sweep: remove any .soloflow/worktrees/TASK-NNN/ dir whose
//     task branch is gone — worktree-merge already cleaned the branch but
//     the dir was left behind (transient remove failure, manual edit, etc).
//     Worktrees whose task branch still exists are PRESERVED (merge-conflict
//     inspection surfaces) and only reported.
//   - git worktree prune to clear stale metadata.
//
// Usage:
//   node sweep-processes.js [--cwd <path>] [--port N] [--base-branch B]
//
// Defaults pulled from active sprint.json + verification.dev_server config
// when not passed explicitly.
//
// Output (JSON to stdout):
//   {
//     "port_swept":         <port|null>,
//     "base_branch":        "<branch|null>",
//     "port_kills":         [ { "pid": N, "method": "SIGTERM" | "SIGKILL" | "already_gone" | "failed", "error"?: "..." } ],
//     "removed_worktrees":  [ { "task_id": "TASK-NNN", "path": "..." } ],
//     "preserved_worktrees":[ { "task_id": "TASK-NNN", "path": "...", "branch": "...", "reason"?: "remove_failed" } ],
//     "pruned":             true | false
//   }

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const config = require('../lib/config');
const paths = require('../lib/paths');
const { tryGit, inRepo } = require('../lib/git');
const { parse } = require('../lib/args');

function execTry(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: (e.stderr || e.message || '').toString().trim(), code: e.status };
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

function sleepMs(ms) {
  spawnSync('sleep', [String(ms / 1000)], { stdio: 'ignore' });
}

function portKill(port) {
  const out = [];
  if (port == null) return out;
  const n = Number(port);
  if (!Number.isFinite(n) || n <= 0) return out;
  const r = execTry('lsof', ['-ti', `:${n}`]);
  if (!r.ok || !r.out) return out;
  const pids = Array.from(new Set(
    r.out.split(/\s+/).filter(Boolean).map(Number).filter((p) => Number.isFinite(p) && p > 0 && p !== process.pid)
  ));
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (e) {
      if (e.code === 'ESRCH') { out.push({ pid, method: 'already_gone' }); continue; }
      out.push({ pid, method: 'failed', error: e.message }); continue;
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidAlive(pid)) sleepMs(100);
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); out.push({ pid, method: 'SIGKILL' }); }
      catch (e) {
        if (e.code === 'ESRCH') out.push({ pid, method: 'already_gone' });
        else out.push({ pid, method: 'failed', error: e.message });
      }
    } else {
      out.push({ pid, method: 'SIGTERM' });
    }
  }
  return out;
}

function worktreeSweep(cwd, baseBranch) {
  const removed = [];
  const preserved = [];
  let pruned = false;
  const wtRoot = paths.worktreesDir(cwd);
  if (fs.existsSync(wtRoot)) {
    const entries = fs.readdirSync(wtRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/^TASK-\d{3,}$/.test(e.name)) continue;
      const wtPath = path.join(wtRoot, e.name);
      const taskId = e.name;
      const taskBranch = baseBranch ? `${baseBranch}-${taskId}` : null;
      const branchExists = taskBranch
        ? tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${taskBranch}`], { cwd }).ok
        : false;
      if (branchExists) {
        preserved.push({ task_id: taskId, path: wtPath, branch: taskBranch });
        continue;
      }
      const rm = tryGit(['worktree', 'remove', '--force', wtPath], { cwd });
      if (!rm.ok && fs.existsSync(wtPath)) {
        try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* leave for next pass */ }
      }
      if (!fs.existsSync(wtPath)) {
        removed.push({ task_id: taskId, path: wtPath });
      } else {
        preserved.push({ task_id: taskId, path: wtPath, branch: taskBranch, reason: 'remove_failed' });
      }
    }
  }
  const pr = tryGit(['worktree', 'prune'], { cwd });
  pruned = pr.ok;
  return { removed, preserved, pruned };
}

function resolveBaseBranch(cwd, override) {
  if (typeof override === 'string' && override.length) return override;
  const active = paths.findActiveSprintIds(cwd);
  for (const entry of active) {
    try {
      const data = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
      const fromTop = data && data.run && data.run.branch;
      if (typeof fromTop === 'string' && fromTop.length) return fromTop;
      const fromSprint = data && data.sprint && data.sprint.run && data.sprint.run.branch;
      if (typeof fromSprint === 'string' && fromSprint.length) return fromSprint;
    } catch { /* skip */ }
  }
  const r = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  return r.ok ? r.out : null;
}

function resolvePort(cwd, override) {
  if (override != null && override !== true) {
    const n = Number(override);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const enabled = config.resolve('verification.dev_server.enabled', false, cwd) === true;
  if (!enabled) return null;
  const port = config.resolve('verification.dev_server.probe_port', null, cwd);
  if (port == null) return null;
  const n = Number(port);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const port = resolvePort(cwd, opts.port);
  const repo = inRepo(cwd);
  const baseBranch = repo ? resolveBaseBranch(cwd, opts['base-branch']) : null;
  const portKills = portKill(port);
  const wt = repo ? worktreeSweep(cwd, baseBranch) : { removed: [], preserved: [], pruned: false };
  const payload = {
    port_swept: port,
    base_branch: baseBranch,
    port_kills: portKills,
    removed_worktrees: wt.removed,
    preserved_worktrees: wt.preserved,
    pruned: wt.pruned,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main();
