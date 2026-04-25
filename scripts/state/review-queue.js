#!/usr/bin/env node
'use strict';

// CLI for human-review-queue.md manipulation.
//
// Subcommands:
//   gather                                → JSON report grouped by bucket
//   gather --group-by action              → group bucketed entries by action text
//   gather --group-by action --bucket actions   → restrict grouping to one bucket
//                                                 (default: actions+testing)
//   append --entry-json '{...}'           → append one entry from JSON
//   append --entry-stdin                  → append entries from stdin (JSON object
//                                           or array)
//   remove --task TASK-NNN [--type X] [--bucket actions]  → remove matching entries
//   override --task TASK-NNN --justification "..."        → flip to type:overridden
//   recompute                              → recompute counts and rewrite
//
// --file <path> overrides the default .soloflow/human-review-queue.md.
//
// Buckets: decisions | actions | testing | deferred_visual.
// Every appended entry must carry `bucket`. Legacy entries (no bucket field)
// are auto-bucketed by classifyBucket() at read time.

const fs = require('fs');
const { parse, die } = require('../lib/args');
const paths = require('../lib/paths');
const rq = require('../lib/review-queue');

const BUCKETS = rq.BUCKETS;

function readStdinSync() {
  return fs.readFileSync(0, 'utf8');
}

function filePath(opts) {
  return opts.file && opts.file !== true ? opts.file : paths.reviewQueuePath();
}

function main() {
  const [subcmd, ...rest] = process.argv.slice(2);
  if (!subcmd) die('review-queue', 'usage: review-queue.js <gather|append|remove|override|recompute> [options]');
  const { opts } = parse(rest, { repeatable: new Set(['type', 'bucket']) });

  if (subcmd === 'gather') {
    const result = rq.gather(filePath(opts));
    if (opts['group-by'] === 'action') {
      const buckets = bucketsFromOpt(opts.bucket, ['actions', 'testing']);
      const flat = [];
      for (const b of buckets) for (const e of result[b] || []) flat.push(e);
      result.action_required_grouped = rq.groupByAction(flat);
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
    for (const e of entries) {
      if (e && typeof e === 'object' && !e.bucket) {
        const inferred = rq.classifyBucket(e);
        if (!inferred) {
          die('review-queue', `entry missing required \`bucket\` field (one of: ${BUCKETS.join('|')}); could not infer from type/level/action`);
        }
        e.bucket = inferred;
      }
      try { pending = rq.appendEntry(filePath(opts), e); }
      catch (err) { die('review-queue', err.message); }
    }
    process.stdout.write(JSON.stringify({ appended: entries.length, pending_count: pending }) + '\n');
    return;
  }

  if (subcmd === 'remove') {
    const task = opts.task;
    const types = opts.type || [];
    const buckets = opts.bucket || [];
    if (!task && types.length === 0 && buckets.length === 0) {
      die('review-queue', 'remove needs --task and/or --type and/or --bucket');
    }
    const predicate = (e) => {
      if (!e) return false;
      if (task && e.task !== task) return false;
      if (types.length > 0 && !types.includes(e.type)) return false;
      if (buckets.length > 0 && !buckets.includes(e.bucket)) return false;
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
    const predicate = (e) => e && e.task === task && e.type !== 'overridden';
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

function bucketsFromOpt(raw, fallback) {
  if (!raw) return fallback;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const v of list) {
    if (v === true) continue;
    if (!BUCKETS.includes(v)) {
      die('review-queue', `unknown --bucket value: ${v} (expected one of ${BUCKETS.join('|')})`);
    }
    out.push(v);
  }
  return out.length === 0 ? fallback : out;
}

main();
