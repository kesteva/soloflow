#!/usr/bin/env node
'use strict';

// Shadow agent drift check and sync utility.
//
// Maintains project-local copies of MCP-dependent SoloFlow agents at
// .claude/agents/*.md so `mcpServers:` frontmatter actually binds MCP tools
// (plugin-scoped subagents have this field silently ignored). Each shadow is
// pinned to a specific plugin version via a sidecar at
// .claude/agents/.soloflow-shadows.json so drift is detectable without
// re-reading every agent file.
//
// Usage:
//   node shadow-agents.js --mode check
//   node shadow-agents.js --mode sync [--set all|visual|research] [--agent name]
//
// Modes:
//   check - emits JSON { plugin_version, drifted, needs_update, shadows: [...] }
//           Exit 0 even when drifted — drift is informational, not an error.
//   sync  - copies selected agents from plugin, writes sidecar, emits
//           JSON { plugin_version, synced, failed }. Exit 1 if any copy failed.
//
// --set aliases (unions with any --agent entries):
//   visual   → verifier.md, sprint-verifier.md
//   research → researcher.md, roadmap-researcher.md
//   all      → all four (default when neither --set nor --agent is given)

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');

const SHADOW_SETS = {
  visual: ['verifier.md', 'sprint-verifier.md'],
  research: ['researcher.md', 'roadmap-researcher.md'],
};
const ALL_SHADOWS = [...SHADOW_SETS.visual, ...SHADOW_SETS.research];

const SIDECAR_PATH = path.join('.claude', 'agents', '.soloflow-shadows.json');

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || null;
}

function pluginVersion() {
  const root = pluginRoot();
  if (!root) return null;
  const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function readSidecar() {
  if (!fs.existsSync(SIDECAR_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SIDECAR_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSidecar(data) {
  fs.mkdirSync(path.dirname(SIDECAR_PATH), { recursive: true });
  fs.writeFileSync(SIDECAR_PATH, JSON.stringify(data, null, 2) + '\n');
}

function shadowPath(name) {
  return path.join('.claude', 'agents', name);
}

function sourcePath(name) {
  const root = pluginRoot();
  if (!root) return null;
  return path.join(root, 'agents', name);
}

function check() {
  const version = pluginVersion();
  const sidecar = readSidecar();
  const shadows = ALL_SHADOWS.map((name) => {
    const present = fs.existsSync(shadowPath(name));
    const recorded = sidecar[name] && sidecar[name].version;
    let status;
    if (!present) status = 'not_installed';
    else if (!recorded) status = 'untracked';
    else if (version && recorded !== version) status = 'stale';
    else status = 'current';
    return { name, present, recorded_version: recorded || null, status };
  });
  // needs_update covers installed-but-drifted shadows. Missing shadows are
  // surfaced via status=not_installed; the caller decides whether to install
  // them based on its own config (e.g., visual verification enabled).
  const needs_update = shadows
    .filter((s) => s.status === 'stale' || s.status === 'untracked')
    .map((s) => s.name);
  return {
    plugin_version: version,
    drifted: needs_update.length > 0,
    needs_update,
    shadows,
  };
}

function selectAgentNames(opts) {
  const setArg = opts.set || null;
  const rawAgents = opts.agent;
  const agentList = rawAgents ? (Array.isArray(rawAgents) ? rawAgents : [rawAgents]) : [];
  const names = new Set();
  if (setArg === 'all') ALL_SHADOWS.forEach((n) => names.add(n));
  else if (setArg && SHADOW_SETS[setArg]) SHADOW_SETS[setArg].forEach((n) => names.add(n));
  else if (setArg) die('shadow-agents', `unknown --set value: ${setArg} (expected: all|visual|research)`);
  agentList.forEach((a) => names.add(a.endsWith('.md') ? a : `${a}.md`));
  if (names.size === 0) ALL_SHADOWS.forEach((n) => names.add(n)); // default = all
  return Array.from(names);
}

function sync(opts) {
  const root = pluginRoot();
  if (!root) die('shadow-agents', 'CLAUDE_PLUGIN_ROOT not set — cannot resolve source agents');
  const version = pluginVersion();
  if (!version) die('shadow-agents', 'could not read plugin version from manifest');

  const names = selectAgentNames(opts);
  const sidecar = readSidecar();
  fs.mkdirSync(path.dirname(SIDECAR_PATH), { recursive: true });

  const synced = [];
  const failed = [];
  for (const name of names) {
    if (!ALL_SHADOWS.includes(name)) {
      failed.push({ name, reason: `not a SoloFlow MCP-dependent agent (expected one of: ${ALL_SHADOWS.join(', ')})` });
      continue;
    }
    const src = sourcePath(name);
    const dst = shadowPath(name);
    if (!fs.existsSync(src)) {
      failed.push({ name, reason: `source not found: ${src}` });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      sidecar[name] = { version, synced_at: new Date().toISOString() };
      synced.push(name);
    } catch (e) {
      failed.push({ name, reason: e.message });
    }
  }
  writeSidecar(sidecar);
  return { plugin_version: version, synced, failed };
}

function main() {
  const { opts } = parse(process.argv.slice(2), { repeatable: new Set(['agent']) });
  const mode = opts.mode;
  if (mode === 'check') {
    process.stdout.write(JSON.stringify(check(), null, 2) + '\n');
    return;
  }
  if (mode === 'sync') {
    const result = sync(opts);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.failed.length) process.exit(1);
    return;
  }
  die('shadow-agents', 'required: --mode check|sync');
}

main();
