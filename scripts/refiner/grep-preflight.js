#!/usr/bin/env node
'use strict';

// Pre-flight grep for global-grep acceptance criteria (task-refiner step 5g).
//
// Runs `grep -rn` (or a user-supplied grep command) against the current
// working tree and returns the unique set of files that match. The refiner
// adds every matched file to the plan's files_owned so the resulting plan
// is internally consistent.
//
// Usage:
//   node grep-preflight.js --pattern '<regex>'
//   node grep-preflight.js --cmd 'grep -rn "oldName" src/ tests/'
//
// Output (JSON):
//   { pattern, cmd, files: ["path1", "path2", ...], count }

const { execFileSync } = require('child_process');
const { parse, die } = require('../lib/args');

function run(cmd) {
  try {
    const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    // grep exits 1 when no matches — that's fine, not an error.
    if (e.status === 1) return { ok: true, out: '' };
    return { ok: false, err: (e.stderr || e.message || '').toString().trim(), code: e.status };
  }
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const pattern = opts.pattern;
  const cmd = opts.cmd;
  if (!pattern && !cmd) die('grep-preflight', 'provide --pattern <regex> or --cmd "<full grep command>"');

  let shellCmd;
  if (cmd && cmd !== true) shellCmd = cmd;
  else {
    // Default: recursive grep excluding common ignore dirs.
    const safePattern = String(pattern).replace(/'/g, "'\\''");
    shellCmd = `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.soloflow '${safePattern}' . 2>/dev/null || true`;
  }

  const r = run(shellCmd);
  if (!r.ok) die('grep-preflight', `grep failed: ${r.err}`);

  const files = new Set();
  for (const line of r.out.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.*?):\d+:/);
    if (m) files.add(m[1].replace(/^\.\//, ''));
  }

  const sorted = Array.from(files).sort();
  process.stdout.write(JSON.stringify({
    pattern: pattern && pattern !== true ? pattern : null,
    cmd: shellCmd,
    files: sorted,
    count: sorted.length,
  }, null, 2) + '\n');
}

main();
