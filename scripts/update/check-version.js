#!/usr/bin/env node
'use strict';

// Check whether a newer SoloFlow version is published on the install's channel.
//
// Reads the locally-installed manifest (or the VERSION stamp left by
// scripts/install.sh), determines the channel from the manifest `name`
// field (`soloflow-dev` → dev branch, else → main), fetches the same
// field from that branch on GitHub, and writes the comparison to a global
// cache so the statusline and SessionStart hook can render an "update
// available" hint.
//
// Cache: ~/.cache/soloflow/update-check.json
// Schema: { checked_at, current_version, latest_version, update_available, channel, source }
//
// Usage:
//   node check-version.js               # cache-aware (no fetch if fresh)
//   node check-version.js --force       # bypass cache freshness, refetch
//   node check-version.js --check-interval-hours 12
//
// Always exits 0. On any failure (no network, parse error, missing local
// version) prints `{}` and leaves the existing cache untouched, so callers
// can treat empty output as "no signal" without special-casing errors.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const REMOTE_URL_BASE = 'https://raw.githubusercontent.com/kesteva/soloflow';
const REMOTE_URL_SUFFIX = '/.claude-plugin/plugin.json';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'soloflow');
const CACHE_PATH = path.join(CACHE_DIR, 'update-check.json');
const FETCH_TIMEOUT_MS = 2000;
const DEFAULT_INTERVAL_HOURS = 24;

function channelForName(name) {
  return name === 'soloflow-dev' ? 'dev' : 'main';
}

function remoteUrlForChannel(channel) {
  return `${REMOTE_URL_BASE}/${channel}${REMOTE_URL_SUFFIX}`;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function readLocalManifest() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
    if (manifest && manifest.version) return { version: manifest.version, name: manifest.name || null };
    try {
      const stamp = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
      if (stamp) return { version: stamp, name: null };
    } catch (e) { /* fall through */ }
  }
  // Repo-local fallback (running from a checkout / dev path).
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 5; i++) {
    const m = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    if (m && m.version) return { version: m.version, name: m.name || null };
    dir = path.dirname(dir);
  }
  return null;
}

function isUpdateEnabled() {
  // Use the shared 3-tier resolver if it's reachable (plugin install ships
  // it under scripts/lib). If not (e.g. ad-hoc invocation), default to true.
  try {
    const config = require('../lib/config');
    const v = config.resolve('update.enabled', true);
    return v !== false && v !== 'false';
  } catch (e) {
    return true;
  }
}

function resolveIntervalHours(cliOverride) {
  if (cliOverride != null) {
    const n = parseInt(cliOverride, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  try {
    const config = require('../lib/config');
    const v = config.resolve('update.check_interval_hours', DEFAULT_INTERVAL_HOURS);
    const n = parseInt(v, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  } catch (e) { /* fall through */ }
  return DEFAULT_INTERVAL_HOURS;
}

function compareSemver(a, b) {
  // Return >0 if a>b, <0 if a<b, 0 if equal. Pre-release suffixes (-rc1) are
  // stripped — we only care about released versions for the "update available"
  // signal.
  const norm = (s) => String(s).split('-')[0].split('.').map(p => parseInt(p, 10) || 0);
  const A = norm(a);
  const B = norm(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function fetchRemoteVersion(remoteUrl) {
  return new Promise((resolve) => {
    const req = https.get(remoteUrl, {
      headers: { 'User-Agent': 'soloflow-update-check' },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const m = JSON.parse(body);
          resolve(m && m.version ? String(m.version) : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function writeCache(payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
  } catch (e) { /* best-effort */ }
}

async function main() {
  if (!isUpdateEnabled()) {
    process.stdout.write('{}\n');
    return;
  }

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  let intervalOverride = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check-interval-hours' && args[i + 1] != null) intervalOverride = args[i + 1];
    else if (args[i].startsWith('--check-interval-hours=')) intervalOverride = args[i].slice('--check-interval-hours='.length);
  }
  const intervalHours = resolveIntervalHours(intervalOverride);

  const local = readLocalManifest();
  if (!local) { process.stdout.write('{}\n'); return; }
  const current = local.version;
  const channel = channelForName(local.name);
  const remoteUrl = remoteUrlForChannel(channel);

  const cached = readJson(CACHE_PATH);
  const fresh = cached && typeof cached.checked_at === 'number'
    && (Date.now() - cached.checked_at * 1000) < intervalHours * 3600 * 1000;

  if (!force && fresh && cached.current_version === current && cached.channel === channel) {
    process.stdout.write(JSON.stringify(cached) + '\n');
    return;
  }

  const latest = await fetchRemoteVersion(remoteUrl);
  if (!latest) {
    // Network failed — preserve prior cache, but if a cache exists for the
    // same current version + channel, surface it so callers still get a
    // useful answer.
    if (cached && cached.current_version === current && cached.channel === channel) {
      process.stdout.write(JSON.stringify(cached) + '\n');
    } else {
      process.stdout.write('{}\n');
    }
    return;
  }

  const payload = {
    checked_at: Math.floor(Date.now() / 1000),
    current_version: current,
    latest_version: latest,
    update_available: compareSemver(latest, current) > 0,
    channel,
    source: remoteUrl,
  };
  writeCache(payload);
  process.stdout.write(JSON.stringify(payload) + '\n');
}

main().catch(() => { process.stdout.write('{}\n'); });
