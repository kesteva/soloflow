#!/usr/bin/env node
'use strict';

// Backfill `created:` frontmatter on existing IDEA files so cruft Scenario 9
// (stale_idea) has a clock to read against. Pre-PR-5 IDEAs may have been
// written without this field; without it, Scenario 9 silently skips them.
//
// Strategy: for each IDEA file under .soloflow/active/ideas/ missing a
// `created:` field, stamp it with the file's mtime (best available proxy
// for "when was this captured"). User can override afterward with a hand
// edit.
//
// Idempotent: re-run skips IDEAs that already have `created:` set.
//
// Usage:
//   node migrate-004-stale-idea-stamp.js [--apply]

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const paths = require('../lib/paths');
const { writeAtomic } = require('../lib/fs-atomic');

const MIGRATION_ID = '004-stale-idea-stamp';

function readStateVersion(cwd) {
  const p = path.join(paths.stateRoot(cwd), 'state-version');
  if (!fs.existsSync(p)) return {};
  try { return yaml.parse(fs.readFileSync(p, 'utf8')) || {}; }
  catch { return {}; }
}

function writeStateVersion(cwd, version) {
  const p = path.join(paths.stateRoot(cwd), 'state-version');
  const text = yaml.serialize(version);
  const content = (text.startsWith('\n') ? text.slice(1) : text) + '\n';
  writeAtomic(p, content);
}

function main() {
  const apply = process.argv.includes('--apply');
  const cwd = process.cwd();

  const ideasDir = path.join(paths.activeDir(cwd), 'ideas');
  if (!fs.existsSync(ideasDir)) {
    process.stdout.write(`migrate-${MIGRATION_ID}: no active/ideas/ directory; nothing to migrate\n`);
    return;
  }

  const stateVersion = readStateVersion(cwd);
  const stamped = [];
  const skipped = [];

  for (const entry of fs.readdirSync(ideasDir)) {
    if (!/^IDEA-\d+\.md$/.test(entry)) continue;
    const ideaPath = path.join(ideasDir, entry);
    const text = fs.readFileSync(ideaPath, 'utf8');
    const split = yaml.splitFrontmatter(text);
    const fm = split.frontmatter || {};
    if (fm.created) {
      skipped.push({ id: entry.replace(/\.md$/, ''), reason: 'already stamped', created: fm.created });
      continue;
    }
    const stat = fs.statSync(ideaPath);
    const stamp = new Date(stat.mtimeMs).toISOString();
    stamped.push({ id: entry.replace(/\.md$/, ''), idea_path: path.relative(cwd, ideaPath), stamp });
    if (apply) {
      writeAtomic(ideaPath, yaml.joinFrontmatter({ ...fm, created: stamp }, split.body));
    }
  }

  const summary = { ideas_dir: path.relative(cwd, ideasDir), stamped, skipped, apply };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (!apply) {
    process.stdout.write(`\nDry run. Re-run with --apply to mutate state.\n`);
    return;
  }

  if (stamped.length > 0) {
    writeStateVersion(cwd, {
      ...stateVersion,
      migrated_004: new Date().toISOString(),
    });
  }
  process.stdout.write(`\nApplied. Stamped ${stamped.length} IDEA(s).\n`);
}

main();
