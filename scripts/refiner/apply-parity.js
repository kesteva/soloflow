#!/usr/bin/env node
'use strict';

// Deterministic post-processing wrapper around ac-parity.js
// (task-refiner rules 5c + 5e; planner Step 2.2c).
//
// Reads a plan file, runs ac-parity.js to detect parity violations,
// then rewrites the plan's YAML frontmatter to fix them in-place:
//   - paths in `move_to_owned`        : moved from `files_readonly` → `files_owned`
//   - paths in `insert_to_owned`      : appended to `files_owned`
//   - paths in `test_targets_missing` : appended to `files_owned`
//
// Idempotent: a clean plan is left byte-identical (no write); a re-run on
// an already-corrected plan produces zero corrections and no write.
//
// Usage:
//   node apply-parity.js --plan path/to/TASK-NNN-plan.md
//
// Output (JSON to stdout):
//   {
//     plan: "...",
//     corrections: [{ path, action }]
//       // action ∈ "readonly_to_owned" | "inserted" | "test_target_added"
//   }

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('../lib/yaml');
const { parse, die } = require('../lib/args');

function runAcParity(planPath) {
  const script = path.join(__dirname, 'ac-parity.js');
  const out = execFileSync('node', [script, '--plan', planPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

// Apply the parity corrections from an ac-parity report to a plan file.
// Returns { corrections: [{path, action}] }. Writes the file only when
// corrections.length > 0; otherwise the file is left untouched.
function applyCorrections(planPath, report) {
  const text = fs.readFileSync(planPath, 'utf8');
  const split = yaml.splitFrontmatter(text);
  if (!split.frontmatter) die('apply-parity', `plan has no YAML frontmatter: ${planPath}`);
  const fm = split.frontmatter;

  const owned = Array.isArray(fm.files_owned) ? [...fm.files_owned] : [];
  let readonly = Array.isArray(fm.files_readonly) ? [...fm.files_readonly] : [];
  const hadReadonly = Array.isArray(fm.files_readonly);

  const seen = new Set(owned);
  const corrections = [];
  const addOwned = (p, action) => {
    if (seen.has(p)) return;
    owned.push(p);
    seen.add(p);
    corrections.push({ path: p, action });
  };

  for (const p of (report.move_to_owned || [])) {
    readonly = readonly.filter((x) => x !== p);
    addOwned(p, 'readonly_to_owned');
  }
  for (const p of (report.insert_to_owned || [])) {
    addOwned(p, 'inserted');
  }
  for (const p of (report.test_targets_missing || [])) {
    addOwned(p, 'test_target_added');
  }

  if (corrections.length === 0) return { corrections };

  fm.files_owned = owned;
  if (hadReadonly) fm.files_readonly = readonly;

  fs.writeFileSync(planPath, yaml.joinFrontmatter(fm, split.body));
  return { corrections };
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const planPath = opts.plan;
  if (!planPath || planPath === true) die('apply-parity', 'provide --plan <path>');
  if (!fs.existsSync(planPath)) die('apply-parity', `plan not found: ${planPath}`);

  const report = runAcParity(planPath);
  const { corrections } = applyCorrections(planPath, report);

  process.stdout.write(JSON.stringify({ plan: planPath, corrections }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { applyCorrections, runAcParity };
