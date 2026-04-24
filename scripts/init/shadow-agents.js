#!/usr/bin/env node
'use strict';

// Shadow agent drift check and sync utility.
//
// Maintains project-local copies of MCP-dependent SoloFlow agents at
// .claude/agents/shadow-*.md so `mcpServers:` frontmatter actually binds
// MCP tools (plugin-scoped subagents have this field silently ignored).
// Source templates live at {plugin_root}/agent-templates/shadow-*.md —
// deliberately outside the plugin's auto-discovered `agents/` directory so
// there is no plugin-scoped `shadow-verifier` (etc.) that would collide with
// the project-local copy and override its `mcpServers:` bindings. Callers
// spawn `shadow-verifier` etc. by name and the harness sees exactly one
// agent, the synced project-local copy. Each shadow carries its own version
// stamp as a YAML comment at the top of its frontmatter, e.g.:
//
//     ---
//     # soloflow-shadow: version=0.8.10 synced=2026-04-23T19:48:32.011Z
//     name: shadow-verifier
//     ...
//     ---
//
// YAML parsers strip comments, so Claude Code's frontmatter loader is
// unaffected. The comment is invisible to the LLM (it's inside the
// frontmatter block, not the body). The sync utility reads the comment via
// regex to detect drift vs. the plugin's current version.
//
// Usage:
//   node shadow-agents.js --mode check
//   node shadow-agents.js --mode sync [--set all|visual|research] [--agent name]
//
// Modes:
//   check - emits JSON { plugin_version, drifted, needs_update, shadows: [...] }
//           Exit 0 even when drifted — drift is informational.
//   sync  - copies selected agents from plugin, injects the version stamp into
//           each shadow, emits JSON { plugin_version, synced, failed }.
//           Exit 1 if any copy failed.
//
// --set aliases (unions with any --agent entries):
//   visual   → shadow-verifier.md, shadow-sprint-verifier.md
//   research → shadow-researcher.md, shadow-roadmap-researcher.md
//   all      → all four (default when neither --set nor --agent is given)

const fs = require('fs');
const path = require('path');
const { parse, die } = require('../lib/args');

const SHADOW_SETS = {
  visual: ['shadow-verifier.md', 'shadow-sprint-verifier.md'],
  research: ['shadow-researcher.md', 'shadow-roadmap-researcher.md'],
};
const ALL_SHADOWS = [...SHADOW_SETS.visual, ...SHADOW_SETS.research];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const STAMP_LINE_RE = /^\s*#\s*soloflow-shadow\s*:/;
const STAMP_VERSION_RE = /^\s*#\s*soloflow-shadow\s*:\s*version=(\S+)(?:\s+synced=(\S+))?/m;

function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  // Fallback: derive from this script's location. Lives at
  // {root}/scripts/init/shadow-agents.js, so walk up looking for the
  // plugin manifest. Claude Code interpolates ${CLAUDE_PLUGIN_ROOT} into
  // slash-command text but does not export it to Bash subprocesses.
  let dir = path.resolve(__dirname, '..', '..');
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
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

function shadowPath(name) {
  return path.join('.claude', 'agents', name);
}

function sourcePath(name) {
  const root = pluginRoot();
  if (!root) return null;
  return path.join(root, 'agent-templates', name);
}

// Read the `# soloflow-shadow: version=X synced=Y` comment from a shadow's
// frontmatter. Returns { version, synced_at } or null if absent/malformed.
function readStamp(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const fm = content.match(FRONTMATTER_RE);
  if (!fm) return null;
  const stamp = fm[1].match(STAMP_VERSION_RE);
  if (!stamp) return null;
  return { version: stamp[1], synced_at: stamp[2] || null };
}

// Inject (or replace) the soloflow-shadow comment at the top of the
// frontmatter. Preserves all other frontmatter lines and the body verbatim.
function injectStamp(source, version, syncedAt) {
  const fm = source.match(FRONTMATTER_RE);
  if (!fm) throw new Error('source has no frontmatter');
  const fmBody = fm[1];
  // Strip any existing soloflow-shadow comment (idempotent re-sync).
  const stripped = fmBody.split(/\r?\n/).filter((line) => !STAMP_LINE_RE.test(line));
  const stamp = `# soloflow-shadow: version=${version} synced=${syncedAt}`;
  const newFmBody = [stamp, ...stripped].join('\n').replace(/\n+$/, '');
  return source.replace(FRONTMATTER_RE, `---\n${newFmBody}\n---\n`);
}

function check() {
  const version = pluginVersion();
  const shadows = ALL_SHADOWS.map((name) => {
    const present = fs.existsSync(shadowPath(name));
    const stamp = present ? readStamp(shadowPath(name)) : null;
    const recorded = stamp ? stamp.version : null;
    let status;
    if (!present) status = 'not_installed';
    else if (!recorded) status = 'untracked';
    else if (version && recorded !== version) status = 'stale';
    else status = 'current';
    return { name, present, recorded_version: recorded, status };
  });
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
  if (names.size === 0) ALL_SHADOWS.forEach((n) => names.add(n));
  return Array.from(names);
}

function sync(opts) {
  const root = pluginRoot();
  if (!root) die('shadow-agents', 'CLAUDE_PLUGIN_ROOT not set — cannot resolve source agents');
  const version = pluginVersion();
  if (!version) die('shadow-agents', 'could not read plugin version from manifest');

  const names = selectAgentNames(opts);
  const syncedAt = new Date().toISOString();
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
      const sourceText = fs.readFileSync(src, 'utf8');
      const stamped = injectStamp(sourceText, version, syncedAt);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, stamped);
      synced.push(name);
    } catch (e) {
      failed.push({ name, reason: e.message });
    }
  }
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

module.exports = { check, sync, SHADOW_SETS, ALL_SHADOWS };

if (require.main === module) main();
