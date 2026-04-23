#!/usr/bin/env node
'use strict';

// files_owned existence check (task-refiner step 5h).
//
// Reads a plan file, checks each path in files_owned. Paths that don't
// exist on disk are reported with basename-matched suggestions so the
// refiner can either correct a typo or confirm new-file creation.
//
// The refiner reconciles each warning against the plan body — if the plan
// explicitly says "create this file" (or equivalent), the entry is a
// legitimate new file and can be kept as-is. Otherwise the refiner
// corrects the path using a suggestion or adds explicit new-file
// language to the plan.
//
// Usage:
//   node files-owned-exist.js --plan path/to/TASK-NNN-plan.md
//
// Output (JSON):
//   {
//     plan: "...",
//     files_owned: [...],
//     missing: [
//       { path: "app/recipe/[id].tsx", suggestions: ["app/(tabs)/recipes/[id].tsx"] }
//     ]
//   }

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const { parse, die } = require('../lib/args');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.soloflow', 'dist', 'build', '.next', '.expo', 'coverage', '.turbo', '.cache']);

function walk(root, results, depth = 0) {
  if (depth > 8) return; // safety cap
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, results, depth + 1);
    else if (entry.isFile()) results.push(full);
  }
}

function findByBasename(basename, repoRoot) {
  const all = [];
  walk(repoRoot, all);
  const matches = all
    .filter((p) => path.basename(p) === basename)
    .map((p) => path.relative(repoRoot, p));
  return matches.slice(0, 5);
}

function main() {
  const { opts } = parse(process.argv.slice(2), {});
  const planPath = opts.plan;
  if (!planPath) die('files-owned-exist', 'required: --plan <path>');
  if (!fs.existsSync(planPath)) die('files-owned-exist', `plan not found: ${planPath}`);

  const raw = fs.readFileSync(planPath, 'utf8');
  const { frontmatter } = yaml.splitFrontmatter(raw);
  const filesOwned = Array.isArray(frontmatter && frontmatter.files_owned) ? frontmatter.files_owned : [];
  const repoRoot = process.cwd();

  const missing = [];
  for (const rel of filesOwned) {
    if (typeof rel !== 'string' || rel.length === 0) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (fs.existsSync(abs)) continue;
    const basename = path.basename(rel);
    const suggestions = basename ? findByBasename(basename, repoRoot) : [];
    missing.push({ path: rel, suggestions });
  }

  process.stdout.write(JSON.stringify({
    plan: planPath,
    files_owned: filesOwned,
    missing,
  }, null, 2) + '\n');
}

main();
