#!/usr/bin/env node
'use strict';

// Transitively expand a sprint-scope selection over backlog.json's depends_on
// graph so the sprint pulls in:
//   - backward: ready-in-backlog deps that the selected tasks need
//   - forward:  ready-in-backlog tasks that become unblocked once the
//               selected tasks complete
//
// Usage:
//   node expand-selection.js --initial TASK-001,TASK-002,...
//
// Output (JSON to stdout):
//   {
//     "initial":        ["TASK-001", ...],
//     "added_backward": ["TASK-NNN", ...],   // sorted by ID
//     "added_forward":  ["TASK-NNN", ...],   // sorted by ID
//     "expanded":       ["TASK-001", ...],   // sorted; initial ∪ added_*
//     "reasons": {
//       "TASK-NNN": { "direction": "backward"|"forward", "via": ["TASK-XXX", ...] }
//     }
//   }
//
// Semantics:
//   - "ready" tasks are tasks in backlog.json with status === "ready".
//     status: "deferred" tasks are excluded (matches `--status ready` filter).
//   - Backward: for each selected T, every dep D where backlog_ready has D
//     gets pulled in.
//   - Forward: a backlog-ready T (not selected, depends_on non-empty) is added
//     iff every dep is either (a) currently in the expanded selection or
//     (b) absent from backlog_ready (treated as external/done — same heuristic
//     as scripts/sprint/ready-tasks.js for sprint-internal scheduling).
//   - Forward never adds an independent task (depends_on === [] / missing) —
//     that would defeat the user's explicit scope choice.
//   - Cycles among ready backlog tasks abort with a non-zero exit + JSON error.

const fs = require('fs');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');

function loadBacklog(cwd) {
  const p = paths.backlogJsonPath(cwd);
  if (!fs.existsSync(p)) die('expand-selection', `${p} not found`);
  let state;
  try { state = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die('expand-selection', `${p} is not valid JSON: ${e.message}`); }
  const tasks = state && state.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    die('expand-selection', `${p} missing tasks object (expected { tasks: { "TASK-NNN": {...} } })`);
  }
  return tasks;
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const initialArg = (opts.initial || '').toString();
  const initial = initialArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (initial.length === 0) die('expand-selection', '--initial is required (comma-separated task IDs)');

  const tasks = loadBacklog(process.cwd());

  const backlogReady = new Map();
  for (const [id, t] of Object.entries(tasks)) {
    if (t && t.status === 'ready') {
      const deps = Array.isArray(t.depends_on) ? t.depends_on.slice() : [];
      backlogReady.set(id, deps);
    }
  }

  for (const id of initial) {
    if (!backlogReady.has(id)) {
      die('expand-selection', `initial task ${id} not found in backlog with status: ready`);
    }
  }

  const selected = new Set(initial);
  const reasons = {};
  const addedBackward = new Set();
  const addedForward = new Set();

  const maxRounds = backlogReady.size + 1;
  let rounds = 0;
  let changed = true;
  while (changed) {
    if (rounds++ > maxRounds) {
      const stuck = Array.from(backlogReady.keys()).filter((id) => !selected.has(id));
      process.stderr.write(JSON.stringify({
        error: 'cycle or fixed-point not reached',
        offending: stuck,
      }) + '\n');
      process.exit(2);
    }
    changed = false;

    for (const T of Array.from(selected)) {
      const deps = backlogReady.get(T) || [];
      for (const D of deps) {
        if (!backlogReady.has(D)) continue;
        if (selected.has(D)) continue;
        selected.add(D);
        addedBackward.add(D);
        reasons[D] = { direction: 'backward', via: [T] };
        changed = true;
      }
    }

    for (const [T, deps] of backlogReady) {
      if (selected.has(T)) continue;
      if (deps.length === 0) continue;
      const inScopeDeps = [];
      let unresolved = false;
      for (const D of deps) {
        if (!backlogReady.has(D)) continue;
        if (selected.has(D)) { inScopeDeps.push(D); continue; }
        unresolved = true;
        break;
      }
      if (unresolved) continue;
      if (inScopeDeps.length === 0) continue;
      selected.add(T);
      addedForward.add(T);
      reasons[T] = { direction: 'forward', via: inScopeDeps };
      changed = true;
    }
  }

  const sortIds = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const expanded = Array.from(selected).sort(sortIds);
  const out = {
    initial: initial.slice().sort(sortIds),
    added_backward: Array.from(addedBackward).sort(sortIds),
    added_forward: Array.from(addedForward).sort(sortIds),
    expanded,
    reasons,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
