#!/usr/bin/env node
'use strict';

// Query .soloflow/active/backlog.json (or sprint.json) without hand-rolled
// `node -e` snippets. `tasks` is an OBJECT keyed by task ID, not an array —
// a footgun that has bitten agents before.
//
// Usage:
//   node backlog-query.js [--source backlog|sprint]
//       [--status <s> ...] [--epic <slug> ...]
//       [--id TASK-NNN ...] [--plan-contains <substr> ...]
//       [--fields id,status,title,epic,depends_on,plan_path]
//       [--format json|ids|count]
//
// Filters within the same flag are OR'd; across flags they are AND'd.
// Default --format is json — an array of `{ id, ...fields }` objects.
// --fields omitted emits every key from the matching tasks, with `id` merged in.

const fs = require('fs');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');

const VALID_SOURCES = new Set(['backlog', 'sprint']);
const VALID_FORMATS = new Set(['json', 'ids', 'count']);

function loadTasks(source, cwd) {
  const p = source === 'sprint' ? paths.sprintJsonPath(cwd) : paths.backlogJsonPath(cwd);
  if (!fs.existsSync(p)) die('backlog-query', `${p} not found`);
  let state;
  try { state = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die('backlog-query', `${p} is not valid JSON: ${e.message}`); }
  const tasks = state && state.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    die('backlog-query', `${p} missing tasks object (expected { tasks: { "TASK-NNN": {...} } })`);
  }
  return tasks;
}

function matchesAny(haystacks, needles, mode = 'equal') {
  if (!needles || needles.length === 0) return true;
  for (const needle of needles) {
    for (const hay of haystacks) {
      if (hay == null) continue;
      if (mode === 'equal' && hay === needle) return true;
      if (mode === 'substring' && String(hay).includes(needle)) return true;
    }
  }
  return false;
}

function projectTask(id, task, fields) {
  if (!fields) return { id, ...task };
  const out = {};
  for (const f of fields) {
    if (f === 'id') out.id = id;
    else if (task && Object.prototype.hasOwnProperty.call(task, f)) out[f] = task[f];
    else out[f] = null;
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'id')) out.id = id;
  return out;
}

function main() {
  const { opts } = parse(process.argv.slice(2), {
    repeatable: new Set(['status', 'epic', 'id', 'plan-contains']),
  });

  const source = opts.source || 'backlog';
  if (!VALID_SOURCES.has(source)) die('backlog-query', `--source must be backlog|sprint, got: ${source}`);

  const format = opts.format || 'json';
  if (!VALID_FORMATS.has(format)) die('backlog-query', `--format must be json|ids|count, got: ${format}`);

  const fields = opts.fields ? String(opts.fields).split(',').map((s) => s.trim()).filter(Boolean) : null;

  const statusFilter = opts.status || [];
  const epicFilter = opts.epic || [];
  const idFilter = opts.id || [];
  const planContainsFilter = opts['plan-contains'] || [];

  const tasks = loadTasks(source, process.cwd());

  const matched = [];
  for (const [id, task] of Object.entries(tasks)) {
    const t = task || {};
    if (!matchesAny([id], idFilter)) continue;
    if (!matchesAny([t.status], statusFilter)) continue;
    if (!matchesAny([t.epic], epicFilter)) continue;
    if (!matchesAny([t.plan_path, t.plan], planContainsFilter, 'substring')) continue;
    matched.push([id, t]);
  }

  matched.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (format === 'count') {
    process.stdout.write(String(matched.length) + '\n');
    return;
  }
  if (format === 'ids') {
    process.stdout.write(matched.map(([id]) => id).join('\n') + (matched.length ? '\n' : ''));
    return;
  }
  const projected = matched.map(([id, t]) => projectTask(id, t, fields));
  process.stdout.write(JSON.stringify(projected, null, 2) + '\n');
}

main();
