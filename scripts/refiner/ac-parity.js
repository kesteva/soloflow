#!/usr/bin/env node
'use strict';

// Acceptance-criteria ↔ files_owned / files_readonly parity check
// (task-refiner step 5e + 5c — for AC verification strings).
//
// Reads a plan file, extracts file paths mentioned in each
// acceptance_criteria[].verification string (and in
// test_strategy.targets[].test_file), then reports mismatches with
// files_owned / files_readonly.
//
// Usage:
//   node ac-parity.js --plan path/to/TASK-NNN-plan.md
//
// Output (JSON):
//   {
//     plan: "...",
//     files_owned: [...],
//     files_readonly: [...],
//     paths_referenced: [...],
//     move_to_owned: [...],       // currently in readonly, should be owned
//     insert_to_owned: [...],     // absent from both, should be owned
//     test_targets_missing: [...] // test_file paths not in files_owned
//   }

const fs = require('fs');
const yaml = require('../lib/yaml');
const { parse, die } = require('../lib/args');

const PATH_RE = /(?:[.\/])?[\w\-\.\/]+\.[a-zA-Z0-9]+/g;
const CMD_HINTS = /\b(grep|cat|head|tail|test\s+-[ef]|open\(|python3?\s+-c|node\s+-e|wc\s+-l|diff|patch)\b/;

function extractPathsFromVerification(str) {
  if (typeof str !== 'string') return [];
  if (!CMD_HINTS.test(str)) return [];
  const hits = new Set();
  for (const m of str.matchAll(PATH_RE)) {
    const p = m[0];
    // Exclude common false-positives.
    if (/^\d+\./.test(p)) continue;            // version number
    if (p.endsWith('.') || p.length < 3) continue;
    if (/^(e\.g|i\.e)\.$/i.test(p)) continue;
    if (!/[\/\w-]/.test(p)) continue;
    // Must contain a real-file-looking extension.
    if (!/\.(ts|tsx|js|jsx|vue|svelte|css|scss|py|rs|go|java|rb|json|ya?ml|md|toml|sh|yml)$/.test(p)) continue;
    hits.add(p.replace(/^\.\//, ''));
  }
  return Array.from(hits);
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const planPath = opts.plan;
  if (!planPath || planPath === true) die('ac-parity', 'provide --plan <path>');
  if (!fs.existsSync(planPath)) die('ac-parity', `plan not found: ${planPath}`);

  const { frontmatter: fm } = yaml.splitFrontmatter(fs.readFileSync(planPath, 'utf8'));
  if (!fm) die('ac-parity', 'plan has no YAML frontmatter');

  const owned = new Set((fm.files_owned || []).map((p) => String(p)));
  const readonly = new Set((fm.files_readonly || []).map((p) => String(p)));

  const acs = fm.acceptance_criteria || [];
  const referenced = new Set();
  for (const ac of acs) {
    if (!ac || typeof ac !== 'object') continue;
    for (const p of extractPathsFromVerification(ac.verification)) referenced.add(p);
  }

  const move_to_owned = [];
  const insert_to_owned = [];
  for (const p of referenced) {
    if (owned.has(p)) continue;
    if (readonly.has(p)) move_to_owned.push(p);
    else insert_to_owned.push(p);
  }

  const test_targets_missing = [];
  const targets = (fm.test_strategy && Array.isArray(fm.test_strategy.targets)) ? fm.test_strategy.targets : [];
  for (const t of targets) {
    if (!t || !t.test_file) continue;
    if (!owned.has(t.test_file)) test_targets_missing.push(t.test_file);
  }

  const out = {
    plan: planPath,
    files_owned: Array.from(owned),
    files_readonly: Array.from(readonly),
    paths_referenced: Array.from(referenced).sort(),
    move_to_owned: move_to_owned.sort(),
    insert_to_owned: insert_to_owned.sort(),
    test_targets_missing: test_targets_missing.sort(),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
