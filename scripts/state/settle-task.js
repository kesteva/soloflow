#!/usr/bin/env node

// SoloFlow state helper — settle a task (done/stuck/blocked/human_needed) and
// optionally commit the .soloflow/ state change.
//
// For `done`: removes the task entry from sprint.json.
// For other verdicts: sets task status to the verdict (and verdict_at timestamp).
//
// Staging is path-explicit: only sprint.json + the provided report + any
// --touched paths get `git add`-ed. Never `git add .` or `-A`.
//
// Usage:
//   node settle-task.js <TASK-ID> <verdict>
//       [--done-report <path>] [--stuck-report <path>]
//       [--touched <path> ...]
//       [--commit-sha <sha>]
//       [--no-commit]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('../lib/paths');

const VALID_VERDICTS = new Set(['done', 'stuck', 'blocked', 'human_needed']);

function die(msg, code = 1) {
  process.stderr.write(`settle-task: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { touched: [], commit: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--done-report') opts.doneReport = argv[++i];
    else if (a === '--stuck-report') opts.stuckReport = argv[++i];
    else if (a === '--touched') opts.touched.push(argv[++i]);
    else if (a === '--commit-sha') opts.commitSha = argv[++i];
    else if (a === '--no-commit') opts.commit = false;
    else if (a.startsWith('--')) die(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) die('usage: settle-task.js <TASK-ID> <verdict> [--done-report <path>] [--stuck-report <path>] [--touched <path> ...] [--commit-sha <sha>] [--no-commit]');
  return { taskId: positional[0], verdict: positional[1], ...opts };
}

function writeAtomic(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function inGitRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const { taskId, verdict, doneReport, stuckReport, touched, commit, commitSha } = parseArgs(process.argv.slice(2));

  if (!/^TASK-\d{3,}$/.test(taskId)) die(`invalid task ID: ${taskId}`);
  if (!VALID_VERDICTS.has(verdict)) die(`invalid verdict: ${verdict} (expected one of: ${[...VALID_VERDICTS].join(', ')})`);

  if (verdict === 'done' && !doneReport) die('--done-report is required when verdict is done');
  if (verdict === 'stuck' && !stuckReport) die('--stuck-report is required when verdict is stuck');

  const cwd = process.cwd();
  const sprintPath = path.join(cwd, '.soloflow', 'active', 'sprint.json');
  if (!fs.existsSync(sprintPath)) die(`${sprintPath} not found`);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
  } catch (e) {
    die(`${sprintPath} is not valid JSON: ${e.message}`);
  }
  if (!state.tasks || typeof state.tasks !== 'object') die(`${sprintPath} missing tasks map`);
  if (!state.tasks[taskId]) die(`${taskId} not found in active sprint`);

  const now = new Date().toISOString();
  let backlogTouched = false;
  const backlogPath = paths.backlogJsonPath(cwd);
  if (verdict === 'done') {
    if (!fs.existsSync(doneReport)) die(`done report not found at ${doneReport} (write it before calling settle-task)`);
    delete state.tasks[taskId];

    // Invariant: backlog.json only contains incomplete tasks. Scrub the task if present.
    // Parse errors / missing file are non-fatal — the sprint.json write is the primary contract.
    if (fs.existsSync(backlogPath)) {
      let backlog;
      try {
        backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));
      } catch (e) {
        process.stderr.write(`settle-task: warning — ${backlogPath} is not valid JSON; skipping backlog scrub (${e.message})\n`);
      }
      if (backlog && backlog.tasks && backlog.tasks[taskId]) {
        delete backlog.tasks[taskId];
        writeAtomic(backlogPath, JSON.stringify(backlog, null, 2) + '\n');
        backlogTouched = true;
      }
    }
  } else {
    if (verdict === 'stuck' && !fs.existsSync(stuckReport)) die(`stuck report not found at ${stuckReport}`);
    const task = state.tasks[taskId];
    task.status = verdict;
    task.verdict_at = now;
    if (commitSha) task.commit = commitSha;
  }

  writeAtomic(sprintPath, JSON.stringify(state, null, 2) + '\n');

  if (!commit) {
    process.stdout.write(`${taskId}: ${verdict} (no-commit)\n`);
    return;
  }

  if (!inGitRepo(cwd)) {
    process.stdout.write(`${taskId}: ${verdict} (not a git repo; skipped commit)\n`);
    return;
  }

  const toStage = [sprintPath];
  if (verdict === 'done' && doneReport) toStage.push(doneReport);
  if (verdict === 'stuck' && stuckReport) toStage.push(stuckReport);
  if (backlogTouched) toStage.push(backlogPath);
  for (const p of touched) {
    if (fs.existsSync(p)) toStage.push(p);
  }

  try {
    git(['add', '--', ...toStage], { cwd });
  } catch (e) {
    die(`git add failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }

  let hasStaged = true;
  try {
    git(['diff', '--cached', '--quiet'], { cwd });
    hasStaged = false;
  } catch {
    hasStaged = true;
  }

  if (!hasStaged) {
    process.stdout.write(`${taskId}: ${verdict} (nothing staged; skipped commit)\n`);
    return;
  }

  const message = `chore(${taskId}): ${verdict.replace('_', '-')}`;
  try {
    git(['commit', '-m', message], { cwd });
  } catch (e) {
    die(`git commit failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }

  process.stdout.write(`${taskId}: ${verdict} (committed: ${message})\n`);
}

main();
