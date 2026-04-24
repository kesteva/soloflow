#!/usr/bin/env node
'use strict';

// Given a list of ready tasks (from ready-tasks.js) and the active sprint, pick
// the next batch of tasks whose `files_owned` do not overlap, capped at
// --max (default: 3). Tasks with empty files_owned run solo (batch of 1).
//
// Usage:
//   node build-batch.js --ready TASK-002,TASK-003,TASK-005 [--max 3]
//
// Output (JSON):
//   {
//     batch:    ["TASK-002", "TASK-005"],
//     deferred: ["TASK-003"],
//     reasons:  { "TASK-003": "overlap:app/auth.ts:TASK-002" }
//   }
//
// Selection algorithm:
// 1. Keep ready order (ready-tasks.js already sorts).
// 2. If a task has non-empty files_owned, admit it only if none of its files
//    overlap with any file already in the batch.
// 3. If a task has empty files_owned, it can only occupy a batch of 1 — admit
//    only when the batch is still empty; otherwise defer.
// 4. Stop when batch reaches --max.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const { parse, die } = require('../lib/args');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.soloflow', 'dist', 'build', '.next', '.expo', 'coverage', '.turbo', '.cache']);

function findPlan(cwd, taskId) {
  const plansDir = path.join(paths.activeDir(cwd), 'plans');
  if (!fs.existsSync(plansDir)) return null;
  const want = `${taskId}-plan.md`;
  const stack = [plansDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === want) return full;
    }
  }
  return null;
}

function readFilesOwned(planPath) {
  const raw = fs.readFileSync(planPath, 'utf8');
  const { frontmatter } = yaml.splitFrontmatter(raw);
  const fo = frontmatter && frontmatter.files_owned;
  if (!Array.isArray(fo)) return [];
  return fo.filter((s) => typeof s === 'string' && s.length > 0);
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const readyArg = (opts.ready || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (readyArg.length === 0) {
    process.stdout.write(JSON.stringify({ batch: [], deferred: [], reasons: {} }, null, 2) + '\n');
    return;
  }
  const max = Number.isFinite(parseInt(opts.max, 10)) ? parseInt(opts.max, 10) : 3;
  if (max < 1) die('build-batch', '--max must be >= 1');

  const cwd = process.cwd();

  const batch = [];
  const deferred = [];
  const reasons = {};
  const usedFiles = new Map(); // file path → task id that owns it in this batch

  for (const taskId of readyArg) {
    if (batch.length >= max) { deferred.push(taskId); reasons[taskId] = 'batch-cap'; continue; }

    const plan = findPlan(cwd, taskId);
    if (!plan) {
      // No plan file — can't prove safety. Defer to a solo batch later.
      deferred.push(taskId);
      reasons[taskId] = 'no-plan-file';
      continue;
    }

    let filesOwned;
    try { filesOwned = readFilesOwned(plan); }
    catch (e) {
      deferred.push(taskId);
      reasons[taskId] = `plan-parse-error:${e.message}`;
      continue;
    }

    if (filesOwned.length === 0) {
      // Empty files_owned — must run solo. Admit only if batch empty.
      if (batch.length === 0) {
        batch.push(taskId);
        // Solo batch: defer everything remaining; orchestrator re-requests next iteration.
        for (let j = readyArg.indexOf(taskId) + 1; j < readyArg.length; j++) {
          const rest = readyArg[j];
          deferred.push(rest);
          reasons[rest] = 'solo-batch-full';
        }
        break;
      } else {
        deferred.push(taskId);
        reasons[taskId] = 'empty-files-owned-needs-solo';
        continue;
      }
    }

    // Check conflict with current batch.
    let conflictFile = null;
    for (const f of filesOwned) {
      if (usedFiles.has(f)) { conflictFile = f; break; }
    }
    if (conflictFile) {
      deferred.push(taskId);
      reasons[taskId] = `overlap:${conflictFile}:${usedFiles.get(conflictFile)}`;
      continue;
    }

    batch.push(taskId);
    for (const f of filesOwned) usedFiles.set(f, taskId);
  }

  process.stdout.write(JSON.stringify({ batch, deferred, reasons }, null, 2) + '\n');
}

main();
