#!/usr/bin/env node
'use strict';

// CLI for per-sprint findings file manipulation.
//
// Subcommands:
//   ensure-exists --sprint SPRINT-NNN           → writeExclusive the scaffold file
//   append --sprint SPRINT-NNN [--id FIND-xxx] --fields-json '{...}'
//                                                → append a new FIND entry
//   set-status --sprint SPRINT-NNN --id FIND-xxx --status resolved [--resolved-by ...]
//   reconcile --sprint SPRINT-NNN --from-done-report <path>
//   recompute --sprint SPRINT-NNN
//
// All subcommands derive the file path from --sprint via
// .soloflow/active/findings/{sprint}-findings.md unless --file is given.

const fs = require('fs');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');
const findings = require('../lib/findings');

function filePath(opts) {
  if (opts.file && opts.file !== true) return opts.file;
  if (opts.sprint && opts.sprint !== true) return paths.findingsFilePath(opts.sprint);
  die('findings', 'provide --sprint SPRINT-NNN (or --file <path>)');
}

function autoId(filePath, sprintId) {
  // Next FIND-<sprint>-<N> using max(N)+1 across existing entries.
  let max = 0;
  if (fs.existsSync(filePath)) {
    const { entries } = findings.parseFile(filePath);
    for (const e of entries) {
      const m = e.id.match(new RegExp(`^FIND-${sprintId.replace(/[-.*+?^${}()|[\\]\\\\]/g, '\\$&')}-(\\d+)$`));
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
  }
  return `FIND-${sprintId}-${max + 1}`;
}

function main() {
  const [subcmd, ...rest] = process.argv.slice(2);
  if (!subcmd) die('findings', 'usage: findings.js <ensure-exists|append|set-status|reconcile|recompute> [options]');
  const { opts } = parse(rest);

  if (subcmd === 'ensure-exists') {
    const sprint = opts.sprint;
    if (!sprint || sprint === true) die('findings', 'ensure-exists needs --sprint SPRINT-NNN');
    const p = filePath(opts);
    const created = findings.ensureExists(p, sprint);
    process.stdout.write(JSON.stringify({ path: p, created }) + '\n');
    return;
  }

  if (subcmd === 'append') {
    const sprint = opts.sprint;
    if (!sprint || sprint === true) die('findings', 'append needs --sprint SPRINT-NNN');
    if (!opts['fields-json']) die('findings', 'append needs --fields-json \'{...}\'');
    let fields;
    try { fields = JSON.parse(opts['fields-json']); }
    catch (e) { die('findings', `--fields-json invalid: ${e.message}`); }
    const p = filePath(opts);
    if (!fs.existsSync(p)) findings.ensureExists(p, sprint);
    const id = (opts.id && opts.id !== true) ? opts.id : autoId(p, sprint);
    const pending = findings.appendEntry(p, { id, fields, fieldOrder: Object.keys(fields) });
    process.stdout.write(JSON.stringify({ id, pending_count: pending }) + '\n');
    return;
  }

  if (subcmd === 'set-status') {
    const id = opts.id;
    const status = opts.status;
    if (!id || id === true) die('findings', 'set-status needs --id FIND-xxx');
    if (!status || status === true) die('findings', 'set-status needs --status <open|resolved|...>');
    const p = filePath(opts);
    const resolvedBy = (opts['resolved-by'] && opts['resolved-by'] !== true) ? opts['resolved-by'] : null;
    const pending = findings.setStatus(p, id, status, resolvedBy);
    process.stdout.write(JSON.stringify({ id, status, pending_count: pending }) + '\n');
    return;
  }

  if (subcmd === 'reconcile') {
    if (!opts['from-done-report'] || opts['from-done-report'] === true) die('findings', 'reconcile needs --from-done-report <path>');
    const p = filePath(opts);
    const result = findings.reconcile(p, opts['from-done-report']);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (subcmd === 'recompute') {
    const p = filePath(opts);
    const pending = findings.recompute(p);
    process.stdout.write(JSON.stringify({ pending_count: pending }) + '\n');
    return;
  }

  die('findings', `unknown subcommand: ${subcmd}`);
}

main();
