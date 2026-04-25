#!/usr/bin/env node
'use strict';

// Sprint-managed dev-server probe.
//
// Reads `verification.dev_server` from config and probes its `probe_url`.
// Used in two places:
//   - sprint-initiator Phase 1 step 9 (full JSON output, drives orchestrator UX)
//   - skills/visual-verify/SKILL.md preflight (--probe-only short output)
//
// Usage:
//   node probe-dev-server.js                # full JSON
//   node probe-dev-server.js --probe-only   # short JSON: { online, skipped? }
//
// Output (full mode):
//   { "enabled": false }                    when verification.dev_server.enabled is false
//   {
//     "enabled": true,
//     "name": "...",
//     "probe_url": "...",
//     "probe_port": NNN,
//     "online": true|false,
//     "managed_by_sprint": true|false,      // sprint.json.dev_server.task_id present AND online
//     "managed_task_id": "..."|null
//   }
//
// Output (--probe-only):
//   { "online": null, "skipped": true }     when disabled — caller continues without preflight
//   { "online": true|false }                when enabled

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('../lib/config');
const { parse } = require('../lib/args');

const PROBE_TIMEOUT_MS = 3000;

function probeHttp(target, matchSubstr) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(target); }
    catch { return resolve({ online: false, reason: 'invalid probe_url' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(target, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ online: false, reason: `status ${res.statusCode}` });
        if (!matchSubstr) return resolve({ online: true });
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.indexOf(matchSubstr) !== -1) return resolve({ online: true });
        return resolve({ online: false, reason: `body missing "${matchSubstr}"` });
      });
    });
    req.on('error', (e) => resolve({ online: false, reason: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, reason: 'timeout' }); });
  });
}

function readManagedTaskId(cwd) {
  const sprintPath = path.join(cwd, '.soloflow', 'active', 'sprint.json');
  if (!fs.existsSync(sprintPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sprintPath, 'utf8'));
    const taskId = data && data.dev_server && data.dev_server.task_id;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : null;
  } catch { return null; }
}

async function main() {
  const { opts } = parse(process.argv.slice(2));
  const probeOnly = opts['probe-only'] === true;

  const enabled = config.resolve('verification.dev_server.enabled', false) === true;
  if (!enabled) {
    if (probeOnly) process.stdout.write(JSON.stringify({ online: null, skipped: true }) + '\n');
    else process.stdout.write(JSON.stringify({ enabled: false }) + '\n');
    return;
  }

  const name = config.resolve('verification.dev_server.name', 'dev-server');
  const probeUrl = config.resolve('verification.dev_server.probe_url', null);
  const probeMatch = config.resolve('verification.dev_server.probe_match', '') || '';
  const probePort = config.resolve('verification.dev_server.probe_port', null);

  if (!probeUrl) {
    if (probeOnly) process.stdout.write(JSON.stringify({ online: false, reason: 'probe_url not configured' }) + '\n');
    else process.stdout.write(JSON.stringify({ enabled: true, name, online: false, reason: 'probe_url not configured', managed_by_sprint: false, managed_task_id: null }) + '\n');
    return;
  }

  const result = await probeHttp(probeUrl, probeMatch);

  if (probeOnly) {
    const out = { online: result.online };
    if (!result.online && result.reason) out.reason = result.reason;
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }

  const managedTaskId = readManagedTaskId(process.cwd());
  const managedBySprint = Boolean(managedTaskId) && result.online === true;

  process.stdout.write(JSON.stringify({
    enabled: true,
    name,
    probe_url: probeUrl,
    probe_port: probePort,
    online: result.online,
    reason: result.online ? undefined : (result.reason || null),
    managed_by_sprint: managedBySprint,
    managed_task_id: managedTaskId,
  }, (k, v) => v === undefined ? undefined : v, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`probe-dev-server: ${e.message}\n`);
  process.exit(1);
});
