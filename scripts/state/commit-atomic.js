#!/usr/bin/env node
'use strict';

// Atomic state-commit wrapper.
//
// - Stages only paths listed via --path (explicit, never `-A`).
// - Skips silently if: not in a git repo, nothing staged, or .soloflow/ is
//   gitignored AND all paths are under .soloflow/.
// - Commits with the provided --message.
//
// Usage:
//   node commit-atomic.js --message "chore(SPRINT-NNN): start sprint" \
//       --path .soloflow/active/sprint.json \
//       --path .soloflow/active/backlog.json
//
// Optional:
//   --allow-empty-paths   don't die if no paths were passed (for idempotent callers)
//   --skip-if-deleted     drop paths that no longer exist (e.g. archived files)

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');
const git = require('../lib/git');

function main() {
  const { opts } = parse(process.argv.slice(2), { repeatable: new Set(['path']) });
  const paths = opts.path || [];
  const message = opts.message;

  if (!message || message === true) die('commit-atomic', '--message is required');
  if (paths.length === 0 && !opts['allow-empty-paths']) die('commit-atomic', 'provide at least one --path (or --allow-empty-paths)');

  const cwd = process.cwd();
  if (!git.inRepo(cwd)) {
    process.stdout.write('skipped: not a git repo\n');
    return;
  }

  const toStage = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    if (fs.existsSync(abs)) toStage.push(p);
    else if (opts['skip-if-deleted']) continue;
    else toStage.push(p); // staged-as-deletion
  }

  if (toStage.length === 0) {
    process.stdout.write('skipped: no paths to stage\n');
    return;
  }

  try { git.addPaths(toStage, cwd); }
  catch (e) { die('commit-atomic', `git add failed: ${e.message}`); }

  if (!git.hasStaged(cwd)) {
    process.stdout.write('skipped: nothing staged\n');
    return;
  }

  try { git.commit(message, cwd); }
  catch (e) { die('commit-atomic', `git commit failed: ${e.message}`); }

  const sha = git.headShort(cwd);
  process.stdout.write(`committed: ${message} (${sha || 'unknown sha'})\n`);
}

main();
