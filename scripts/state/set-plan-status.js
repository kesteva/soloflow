#!/usr/bin/env node
'use strict';

// Atomically update the `status` frontmatter of one or more plan files.
// Used by sprint-initiator (ready → in-flight on selection), compounder
// (newly-emitted plans default to ready), and any other phase that
// transitions plan state.
//
// Usage:
//   node set-plan-status.js <new-status> <TASK-ID> [<TASK-ID> ...]
//
// new-status must be one of: ready | deferred | in-flight | done.
//
// Output (JSON to stdout):
//   {
//     "updated": [{ "id": "TASK-NNN", "plan_path": "...", "previous": "ready" }, ...],
//     "skipped": [{ "id": "TASK-NNN", "reason": "no plan file" }, ...]
//   }
//
// Exit non-zero if any input ID is invalid (bad ID format) or status is
// unrecognized. A missing plan file is a "skipped" entry, not a hard error.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const { writeAtomic } = require('../lib/fs-atomic');

const VALID_PLAN_STATUSES = new Set(['ready', 'deferred', 'in-flight', 'done']);

function die(msg, code = 1) {
  process.stderr.write(`set-plan-status: ${msg}\n`);
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

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) die('usage: set-plan-status.js <new-status> <TASK-ID> [<TASK-ID> ...]');
  const [status, ...ids] = argv;
  if (!VALID_PLAN_STATUSES.has(status)) {
    die(`invalid status: ${status} (expected one of: ${[...VALID_PLAN_STATUSES].join(', ')})`);
  }
  for (const id of ids) {
    if (!/^TASK-\d{3,}$/.test(id)) die(`invalid task ID: ${id}`);
  }

  const cwd = process.cwd();
  const planByTask = globPlanFiles(path.join(paths.activeDir(cwd), 'plans'));

  const updated = [];
  const skipped = [];
  for (const id of ids) {
    const planPath = planByTask.get(id);
    if (!planPath) {
      skipped.push({ id, reason: 'no plan file' });
      continue;
    }
    const text = fs.readFileSync(planPath, 'utf8');
    const split = yaml.splitFrontmatter(text);
    const fm = split.frontmatter || {};
    const previous = fm.status || null;
    if (previous === status) {
      skipped.push({ id, reason: 'already at target status' });
      continue;
    }
    const newFm = { ...fm, status };
    writeAtomic(planPath, yaml.joinFrontmatter(newFm, split.body));
    updated.push({ id, plan_path: path.relative(cwd, planPath), previous });
  }

  process.stdout.write(JSON.stringify({ updated, skipped }, null, 2) + '\n');
}

main();
