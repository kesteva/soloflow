#!/usr/bin/env node
'use strict';

// Query SoloFlow plan files (active/plans/**/TASK-*-plan.md) by frontmatter.
// Replaces backlog-query.js — the queue of work is now expressed as
// frontmatter `status` on plan files, not a separate backlog.json.
//
// Usage:
//   node plan-query.js [--status <s> ...] [--epic <slug> ...]
//       [--id TASK-NNN ...] [--plan-contains <substr> ...]
//       [--fields id,status,title,epic,depends_on,plan_path]
//       [--format json|ids|count]
//
// Filters within the same flag are OR'd; across flags they are AND'd.
// Default --format is json — an array of `{ id, ...frontmatter }` objects
// with a synthetic `plan_path` (relative to cwd) merged in.

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');

const VALID_FORMATS = new Set(['json', 'ids', 'count']);

function globPlans(plansRoot) {
  const out = [];
  if (!fs.existsSync(plansRoot)) return out;
  const stack = [plansRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && /^TASK-\d+-plan\.md$/.test(e.name)) out.push(p);
    }
  }
  return out;
}

function loadPlanFm(planPath) {
  let text;
  try { text = fs.readFileSync(planPath, 'utf8'); }
  catch { return {}; }
  const split = yaml.splitFrontmatter(text);
  return split.frontmatter || {};
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

function projectTask(id, fm, fields) {
  if (!fields) return { id, ...fm };
  const out = {};
  for (const f of fields) {
    if (f === 'id') out.id = id;
    else if (fm && Object.prototype.hasOwnProperty.call(fm, f)) out[f] = fm[f];
    else out[f] = null;
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'id')) out.id = id;
  return out;
}

function main() {
  const { opts } = parse(process.argv.slice(2), {
    repeatable: new Set(['status', 'epic', 'id', 'plan-contains']),
  });

  const format = opts.format || 'json';
  if (!VALID_FORMATS.has(format)) die('plan-query', `--format must be json|ids|count, got: ${format}`);

  const fields = opts.fields ? String(opts.fields).split(',').map((s) => s.trim()).filter(Boolean) : null;

  const statusFilter = opts.status || [];
  const epicFilter = opts.epic || [];
  const idFilter = opts.id || [];
  const planContainsFilter = opts['plan-contains'] || [];

  const cwd = process.cwd();
  const plansRoot = path.join(paths.activeDir(cwd), 'plans');
  const planFiles = globPlans(plansRoot);

  const matched = [];
  for (const planPath of planFiles) {
    const m = path.basename(planPath).match(/^TASK-(\d+)-plan\.md$/);
    if (!m) continue;
    const id = `TASK-${m[1]}`;
    const fm = loadPlanFm(planPath);
    fm.plan_path = path.relative(cwd, planPath);

    if (!matchesAny([id], idFilter)) continue;
    if (!matchesAny([fm.status], statusFilter)) continue;
    if (!matchesAny([fm.epic], epicFilter)) continue;
    if (!matchesAny([fm.plan_path], planContainsFilter, 'substring')) continue;
    matched.push([id, fm]);
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
  const projected = matched.map(([id, fm]) => projectTask(id, fm, fields));
  process.stdout.write(JSON.stringify(projected, null, 2) + '\n');
}

main();
