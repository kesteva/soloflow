'use strict';

const { execFileSync } = require('child_process');

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function tryGit(args, opts = {}) {
  try { return { ok: true, out: git(args, opts).trim() }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString().trim() }; }
}

function inRepo(cwd = process.cwd()) {
  return tryGit(['rev-parse', '--is-inside-work-tree'], { cwd }).ok;
}

function isIgnored(path, cwd = process.cwd()) {
  return tryGit(['check-ignore', '-q', path], { cwd }).ok;
}

function hasStaged(cwd = process.cwd()) {
  // `git diff --cached --quiet` exits 0 if nothing staged, 1 if staged changes.
  const r = tryGit(['diff', '--cached', '--quiet'], { cwd });
  return !r.ok; // not-ok => exit 1 => staged changes
}

function addPaths(paths, cwd = process.cwd()) {
  if (paths.length === 0) return;
  git(['add', '--', ...paths], { cwd });
}

function commit(message, cwd = process.cwd()) {
  git(['commit', '-m', message], { cwd });
}

function headShort(cwd = process.cwd()) {
  const r = tryGit(['rev-parse', '--short', 'HEAD'], { cwd });
  return r.ok ? r.out : null;
}

module.exports = { git, tryGit, inRepo, isIgnored, hasStaged, addPaths, commit, headShort };
