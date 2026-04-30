#!/usr/bin/env node
'use strict';

// Transitively expand a sprint-scope selection over plan frontmatter
// `depends_on` so the sprint pulls in:
//   - backward: ready plans that the selected tasks need
//   - forward:  ready plans that become unblocked once the selected tasks
//               complete
//
// "Ready" here means a plan file under .soloflow/active/plans/ whose
// frontmatter `status` is `ready` (status: deferred is excluded).
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
//   - Backward: for each selected T, every dep D where the plan exists with
//     status:ready gets pulled in.
//   - Forward: a ready plan T (not selected, depends_on non-empty) is added
//     iff every dep is either (a) currently in the expanded selection or
//     (b) absent from ready plans (treated as external/done — same heuristic
//     as scripts/sprint/ready-tasks.js for sprint-internal scheduling).
//   - Forward never adds an independent task (depends_on === [] / missing) —
//     that would defeat the user's explicit scope choice.
//   - Cycles among ready plans abort with a non-zero exit + JSON error.

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');

function loadReadyPlans(cwd) {
  const plansRoot = path.join(paths.activeDir(cwd), 'plans');
  const ready = new Map(); // id -> depends_on[]
  if (!fs.existsSync(plansRoot)) return ready;
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
      if (!m) continue;
      const id = `TASK-${m[1]}`;
      let fm;
      try {
        const text = fs.readFileSync(p, 'utf8');
        fm = yaml.splitFrontmatter(text).frontmatter || {};
      } catch { continue; }
      if (fm.status !== 'ready') continue;
      const deps = Array.isArray(fm.depends_on) ? fm.depends_on.slice() : [];
      ready.set(id, deps);
    }
  }
  return ready;
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const initialArg = (opts.initial || '').toString();
  const initial = initialArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (initial.length === 0) die('expand-selection', '--initial is required (comma-separated task IDs)');

  const ready = loadReadyPlans(process.cwd());

  for (const id of initial) {
    if (!ready.has(id)) {
      die('expand-selection', `initial task ${id} not found among ready plans (status: ready)`);
    }
  }

  const selected = new Set(initial);
  const reasons = {};
  const addedBackward = new Set();
  const addedForward = new Set();

  const maxRounds = ready.size + 1;
  let rounds = 0;
  let changed = true;
  while (changed) {
    if (rounds++ > maxRounds) {
      const stuck = Array.from(ready.keys()).filter((id) => !selected.has(id));
      process.stderr.write(JSON.stringify({
        error: 'cycle or fixed-point not reached',
        offending: stuck,
      }) + '\n');
      process.exit(2);
    }
    changed = false;

    for (const T of Array.from(selected)) {
      const deps = ready.get(T) || [];
      for (const D of deps) {
        if (!ready.has(D)) continue;
        if (selected.has(D)) continue;
        selected.add(D);
        addedBackward.add(D);
        reasons[D] = { direction: 'backward', via: [T] };
        changed = true;
      }
    }

    for (const [T, deps] of ready) {
      if (selected.has(T)) continue;
      if (deps.length === 0) continue;
      const inScopeDeps = [];
      let unresolved = false;
      for (const D of deps) {
        if (!ready.has(D)) continue;
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
