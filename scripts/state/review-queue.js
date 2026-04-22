#!/usr/bin/env node
'use strict';

// CLI for human-review-queue.md manipulation.
//
// Subcommands:
//   gather                         → JSON report grouped by type
//   gather --group-by action       → action_required entries grouped by action text
//   append --entry-json '{...}'    → append one entry from JSON
//   append --entry-stdin           → append entries from stdin (either a JSON object
//                                    or a JSON array)
//   remove --task TASK-NNN [--type action_required] → remove matching entries
//   override --task TASK-NNN --justification "..."  → flip to type:overridden
//   recompute                       → just recompute pending_count and rewrite
//
// --file <path> overrides the default .soloflow/human-review-queue.md.

const fs = require('fs');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');
const rq = require('../lib/review-queue');

function readStdinSync() {
  return fs.readFileSync(0, 'utf8');
}

function filePath(opts) {
  return opts.file && opts.file !== true ? opts.file : paths.reviewQueuePath();
}

function main() {
  const [subcmd, ...rest] = process.argv.slice(2);
  if (!subcmd) die('review-queue', 'usage: review-queue.js <gather|append|remove|override|recompute> [options]');
  const { opts } = parse(rest, { repeatable: new Set(['type']) });

  if (subcmd === 'gather') {
    const result = rq.gather(filePath(opts));
    if (opts['group-by'] === 'action') {
      result.action_required_grouped = rq.groupByAction(result.action_required);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (subcmd === 'append') {
    let entries;
    if (opts['entry-stdin']) {
      const raw = readStdinSync().trim();
      if (!raw) die('review-queue', 'no entry on stdin');
      try { entries = JSON.parse(raw); }
      catch (e) { die('review-queue', `stdin is not valid JSON: ${e.message}`); }
    } else if (opts['entry-json']) {
      try { entries = JSON.parse(opts['entry-json']); }
      catch (e) { die('review-queue', `--entry-json is not valid JSON: ${e.message}`); }
    } else {
      die('review-queue', 'append needs --entry-json or --entry-stdin');
    }
    if (!Array.isArray(entries)) entries = [entries];
    let pending = 0;
    for (const e of entries) pending = rq.appendEntry(filePath(opts), e);
    process.stdout.write(JSON.stringify({ appended: entries.length, pending_count: pending }) + '\n');
    return;
  }

  if (subcmd === 'remove') {
    const task = opts.task;
    const types = opts.type || [];
    if (!task && types.length === 0) die('review-queue', 'remove needs --task and/or --type');
    const predicate = (e) => {
      if (!e) return false;
      if (task && e.task !== task) return false;
      if (types.length > 0 && !types.includes(e.type)) return false;
      return true;
    };
    const removed = rq.removeEntries(filePath(opts), predicate);
    process.stdout.write(JSON.stringify({ removed }) + '\n');
    return;
  }

  if (subcmd === 'override') {
    const task = opts.task;
    const justification = opts.justification;
    if (!task || !justification || justification === true) die('review-queue', 'override needs --task and --justification');
    const predicate = (e) => e && e.task === task && e.type === 'action_required';
    const count = rq.overrideEntry(filePath(opts), predicate, justification);
    process.stdout.write(JSON.stringify({ overridden: count }) + '\n');
    return;
  }

  if (subcmd === 'recompute') {
    const state = rq.parseFile(filePath(opts));
    const pending = rq.rewrite(filePath(opts), state.entries);
    process.stdout.write(JSON.stringify({ pending_count: pending }) + '\n');
    return;
  }

  die('review-queue', `unknown subcommand: ${subcmd}`);
}

main();
