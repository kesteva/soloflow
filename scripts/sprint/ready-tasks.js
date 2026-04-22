#!/usr/bin/env node
'use strict';

// Build a dependency graph from sprint.json.tasks[].depends_on and emit the
// set of tasks that are ready to execute right now (dependencies all complete
// or absent). Also surfaces tasks blocked by unresolved dependencies.
//
// Usage:
//   node ready-tasks.js [--completed TASK-NNN,TASK-MMM]
//
// Output (JSON):
//   {
//     "ready":    ["TASK-002", ...],
//     "in_progress": ["TASK-007", ...],
//     "blocked": { "TASK-003": ["TASK-002"] },
//     "cycles":  [["TASK-A","TASK-B"], ...]  // empty if acyclic
//   }
//
// A task is "ready" when its status is "pending" and every entry in its
// depends_on is either (a) listed in --completed, (b) absent from sprint.json
// (treated as externally complete), or (c) has status "done" (if present).

const fs = require('fs');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');

function loadSprint(cwd) {
  const p = paths.sprintJsonPath(cwd);
  if (!fs.existsSync(p)) die('ready-tasks', 'no sprint.json found');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die('ready-tasks', `sprint.json invalid: ${e.message}`); }
}

function findCycles(nodes, deps) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const n of nodes) color.set(n, WHITE);
  const cycles = [];

  function dfs(n, stack) {
    color.set(n, GRAY);
    stack.push(n);
    for (const d of deps.get(n) || []) {
      if (!color.has(d)) continue; // external dep, skip
      const c = color.get(d);
      if (c === GRAY) {
        const idx = stack.indexOf(d);
        cycles.push(stack.slice(idx).concat([d]));
      } else if (c === WHITE) {
        dfs(d, stack);
      }
    }
    stack.pop();
    color.set(n, BLACK);
  }
  for (const n of nodes) if (color.get(n) === WHITE) dfs(n, []);
  return cycles;
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const completedArg = (opts.completed || '').split(',').map((s) => s.trim()).filter(Boolean);
  const completed = new Set(completedArg);

  const state = loadSprint(process.cwd());
  const tasks = state.tasks || {};
  const ids = Object.keys(tasks);

  for (const [id, t] of Object.entries(tasks)) {
    if (t && t.status === 'done') completed.add(id);
  }

  const deps = new Map();
  for (const id of ids) {
    const d = (tasks[id] && tasks[id].depends_on) || [];
    deps.set(id, Array.isArray(d) ? d : []);
  }

  const ready = [];
  const inProgress = [];
  const blocked = {};
  for (const id of ids) {
    const status = tasks[id] && tasks[id].status;
    if (status === 'done') continue;
    if (status === 'in_progress') { inProgress.push(id); continue; }
    if (status === 'blocked' || status === 'stuck' || status === 'human_needed') continue;

    const unresolved = [];
    for (const d of deps.get(id) || []) {
      if (completed.has(d)) continue;
      if (!ids.includes(d)) continue; // external dep — treat as satisfied
      unresolved.push(d);
    }
    if (unresolved.length === 0) ready.push(id);
    else blocked[id] = unresolved;
  }

  ready.sort();
  inProgress.sort();

  const cycles = findCycles(ids, deps);

  process.stdout.write(JSON.stringify({ ready, in_progress: inProgress, blocked, cycles }, null, 2) + '\n');
}

main();
