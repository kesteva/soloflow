#!/usr/bin/env node
'use strict';

// Walk every migrate-NNN-*.js in numeric order, run each as a child
// process, and aggregate their JSON / sentinel output into a single
// summary. Without --apply this is a pure dry run; with --apply each
// non-no-op migrator is re-spawned with --apply.
//
// Output: JSON to stdout with shape:
//   {
//     "migrators": [
//       { "id": "001-backlog-to-frontmatter", "pending": false, "summary": "...stdout text..." },
//       ...
//     ],
//     "total_pending": N,
//     "applied": [...]   // populated only when --apply ran
//   }
//
// Detection of "no-op vs pending" relies on sentinel strings each migrator
// already prints when there's nothing to do, plus a JSON-aware fallback for
// the case where the migrator runs cleanly but its diff is empty.
//
// Usage:
//   node run-all.js               # dry run
//   node run-all.js --apply       # apply each pending migrator in order

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIGRATIONS_DIR = __dirname;

const NO_OP_SENTINELS = [
  /nothing to migrate/i,
  /already applied at/i,
  /no active\/ideas/i,
];

function discoverMigrators() {
  const out = [];
  for (const entry of fs.readdirSync(MIGRATIONS_DIR)) {
    const m = entry.match(/^migrate-(\d{3})-.+\.js$/);
    if (!m) continue;
    out.push({ num: parseInt(m[1], 10), file: entry, full: path.join(MIGRATIONS_DIR, entry), id: entry.replace(/^migrate-/, '').replace(/\.js$/, '') });
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

function extractJson(stdout) {
  // Migrators print a JSON block (possibly multi-line) followed by a
  // trailing prose line ("Dry run..." or "Applied..."). Pull out the first
  // balanced object.
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < stdout.length; i++) {
    if (stdout[i] === '{') depth++;
    else if (stdout[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(stdout.slice(start, i + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function classifyPending(stdout, json) {
  for (const re of NO_OP_SENTINELS) if (re.test(stdout)) return false;
  if (json) {
    // 001: plans_to_update is the change count.
    if (typeof json.plans_to_update === 'number') return json.plans_to_update > 0;
    // 002: skipped_reason ("target already exists") means no move planned.
    if (typeof json.legacy_path === 'string') return !json.skipped_reason;
    // 004: stamped[] is the change list.
    if (Array.isArray(json.stamped)) return json.stamped.length > 0;
  }
  // Output present but unrecognized — surface as pending so the user sees it.
  return true;
}

function runMigrator(full, args, cwd) {
  const r = spawnSync('node', [full, ...args], { cwd, encoding: 'utf8' });
  const stdout = (r.stdout || '').toString();
  const stderr = (r.stderr || '').toString();
  return {
    code: r.status == null ? -1 : r.status,
    stdout,
    stderr,
  };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const cwd = process.cwd();

  const migrators = discoverMigrators();
  const dryResults = [];
  for (const m of migrators) {
    const r = runMigrator(m.full, [], cwd);
    const json = extractJson(r.stdout);
    const pending = classifyPending(r.stdout, json);
    dryResults.push({ id: m.id, file: m.file, pending, summary: r.stdout.trim(), stderr: r.stderr.trim(), exit_code: r.code });
  }

  const totalPending = dryResults.filter((d) => d.pending).length;

  if (!apply) {
    process.stdout.write(JSON.stringify({
      apply: false,
      migrators: dryResults,
      total_pending: totalPending,
    }, null, 2) + '\n');
    return;
  }

  // Apply path. Re-spawn each pending migrator with --apply, in order.
  // Bail at first non-zero exit.
  const applied = [];
  for (const d of dryResults) {
    if (!d.pending) {
      applied.push({ id: d.id, status: 'skipped_no_op' });
      continue;
    }
    const m = migrators.find((mm) => mm.id === d.id);
    const r = runMigrator(m.full, ['--apply'], cwd);
    if (r.code !== 0) {
      applied.push({ id: d.id, status: 'failed', exit_code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
      process.stdout.write(JSON.stringify({
        apply: true,
        bailed: true,
        migrators: dryResults,
        total_pending: totalPending,
        applied,
      }, null, 2) + '\n');
      process.exit(1);
    }
    applied.push({ id: d.id, status: 'applied', summary: r.stdout.trim() });
  }

  process.stdout.write(JSON.stringify({
    apply: true,
    migrators: dryResults,
    total_pending: totalPending,
    applied,
  }, null, 2) + '\n');
}

main();
