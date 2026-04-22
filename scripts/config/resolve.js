#!/usr/bin/env node
'use strict';

// Resolve SoloFlow config values via the 3-tier recipe:
//   .soloflow/config.json → $CLAUDE_PLUGIN_ROOT/config/defaults.yaml → inline fallback
//
// Usage:
//   node resolve.js --key models.executor [--fallback sonnet]
//     → prints the resolved scalar to stdout (one line, no quotes).
//
//   node resolve.js --all
//     → prints the merged config as JSON to stdout.
//
// Multiple --key flags return one line each, in order (useful for batch lookups).

const { parse, die } = require('../lib/args');
const config = require('../lib/config');

function main() {
  const { opts } = parse(process.argv.slice(2), { repeatable: new Set(['key', 'fallback']) });

  if (opts.all) {
    process.stdout.write(JSON.stringify(config.resolveAll(), null, 2) + '\n');
    return;
  }

  const keys = opts.key || [];
  const fallbacks = opts.fallback || [];
  if (keys.length === 0) die('resolve', 'provide --key <dotted.key> [--fallback <value>] (or --all)');

  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const fb = fallbacks[i] !== undefined ? fallbacks[i] : '';
    const v = config.resolve(keys[i], fb);
    out.push(v === null || v === undefined ? '' : String(v));
  }
  process.stdout.write(out.join('\n') + '\n');
}

main();
