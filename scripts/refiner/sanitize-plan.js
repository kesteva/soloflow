#!/usr/bin/env node
'use strict';

// Strip post-fence debug output from a detailer's raw plan response.
//
// Some clients append telemetry tokens (agentId:, <usage>, <input_tokens>, ...)
// or chain-of-thought prose after the closing markdown fence. The orchestrator
// must not persist that into TASK-NNN-plan.md. This script extracts the canonical
// plan body (frontmatter + markdown body) and reports how many bytes were stripped.
//
// Usage:
//   node sanitize-plan.js --task-id TASK-NNN < raw-response.txt
//   node sanitize-plan.js --task-id TASK-NNN --input <path>
//
// Output (JSON to stdout):
//   {
//     "body": "<sanitized plan content>",
//     "stripped_bytes": <int>,
//     "frontmatter_found": true|false,
//     "id_matches_expected": true|false|null
//   }

const fs = require('fs');
const { parse, die } = require('../lib/args');

function readInput(opts) {
  if (opts.input && opts.input !== true) {
    return fs.readFileSync(opts.input, 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function sanitize(raw, expectedTaskId) {
  const original = raw.replace(/\r\n/g, '\n');
  let working = original;

  // Peel outer markdown fence wrapper if the entire response is wrapped in
  // ```markdown ... ``` (some clients emit it, some don't). Anything after
  // the closing wrap fence is debug and discarded.
  const wrap = working.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```[\s\S]*$/);
  if (wrap) working = wrap[1];

  // Locate the frontmatter block: ---\n...\nid: TASK-NNN
  // Allow up to ~10 lines of slack between the opening --- and the id: line
  // (some plans put e.g. `idea:` before `id:`).
  const fmRe = /(?:^|\n)(---\s*\n(?:[^\n]*\n){0,10}id:\s*(TASK-\d+)[\s\S]*?)$/;
  const fmMatch = working.match(fmRe);
  let frontmatterFound = false;
  let idMatchesExpected = null;

  if (fmMatch) {
    frontmatterFound = true;
    working = fmMatch[1];
    if (expectedTaskId) {
      idMatchesExpected = fmMatch[2] === expectedTaskId;
    }
  }

  // Walk the lines and cut at the first telemetry sentinel (any line whose
  // start matches a known debug pattern). Everything from that sentinel
  // onward is dropped.
  const sentinels = [
    /^agentId:/,
    /^<\/?usage\b/,
    /^\s*<\/?(input|output)_tokens\b/i,
    /^\s*<\/?cache_(creation|read)_input_tokens\b/i,
    /^\s*<\/?service_tier\b/i,
  ];
  const lines = working.split('\n');
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (sentinels.some((re) => re.test(lines[i]))) {
      endIdx = i;
      break;
    }
  }

  const body = lines.slice(0, endIdx).join('\n').replace(/\s+$/g, '') + '\n';
  const strippedBytes = Math.max(0, original.length - body.length);

  return {
    body,
    stripped_bytes: strippedBytes,
    frontmatter_found: frontmatterFound,
    id_matches_expected: idMatchesExpected,
  };
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const taskId = opts['task-id'] && opts['task-id'] !== true ? String(opts['task-id']) : null;
  if (taskId && !/^TASK-\d+$/.test(taskId)) {
    die('sanitize-plan', `--task-id must match TASK-\\d+ (got "${taskId}")`);
  }

  let raw;
  try {
    raw = readInput(opts);
  } catch (e) {
    die('sanitize-plan', `failed to read input: ${e.message}`);
  }

  const result = sanitize(raw, taskId);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { sanitize };
