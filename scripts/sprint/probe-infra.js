#!/usr/bin/env node
'use strict';

// Task-level infra availability probe (sprint-initiator.md step 6.5).
//
// Reads selected task plans, infers required infra categories (maestro,
// playwright, docker) from keyword scans, probes availability via shell,
// and probes per-task `prerequisites[]` blocks from plan frontmatter.
//
// Usage:
//   node probe-infra.js --plan path/to/TASK-001-plan.md --plan path/to/TASK-002-plan.md
//
// Output (JSON):
//   {
//     required: ["maestro", "playwright", "docker"],
//     available: ["playwright"],
//     missing: [ { category, reason, impacts: [{ task_id, test_targets }] } ],
//     task_prerequisites: [ { task_id, description, status, blocking, fix } ]
//   }

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('../lib/yaml');
const { parse, die } = require('../lib/args');

const MOBILE_RE = /\b(ios|android|mobile|maestro|simulator|react-native)\b/i;
const WEB_RE = /\b(browser|playwright|e2e|web|page\.|screenshot)\b/i;
const DOCKER_RE = /\b(docker|container|compose|dockerfile)\b/i;
const SERVICE_RE = /\b(postgres|redis|rabbitmq|mysql)\b/i;
const SERVICE_ACTION_RE = /\b(start|spin up|local|test against|container)\b/i;

function taskIdOf(planPath) {
  const m = path.basename(planPath).match(/^TASK-(\d+)-plan\.md$/);
  return m ? `TASK-${m[1]}` : path.basename(planPath);
}

function readPlan(planPath) {
  if (!fs.existsSync(planPath)) return { fm: {}, body: '', missing: true };
  const raw = fs.readFileSync(planPath, 'utf8');
  const { frontmatter, body } = yaml.splitFrontmatter(raw);
  return { fm: frontmatter || {}, body: body || '' };
}

function categoriesForPlan(planPath) {
  const { fm, body } = readPlan(planPath);
  const filesOwned = Array.isArray(fm.files_owned) ? fm.files_owned.join(' ') : '';
  const testStrategy = fm.test_strategy && Array.isArray(fm.test_strategy.targets) ? fm.test_strategy.targets : [];
  const hasIntegration = testStrategy.some((t) => t && t.type === 'integration');
  const combined = `${filesOwned}\n${body}`;
  const categories = new Set();
  if (hasIntegration && MOBILE_RE.test(combined)) categories.add('maestro');
  if (hasIntegration && WEB_RE.test(combined) && !MOBILE_RE.test(combined)) categories.add('playwright');
  if (DOCKER_RE.test(combined)) categories.add('docker');
  else if (SERVICE_RE.test(combined) && SERVICE_ACTION_RE.test(combined)) categories.add('docker');
  return { categories: Array.from(categories), test_targets: testStrategy.map((t) => t && t.behavior).filter(Boolean) };
}

function tryShell(cmd) {
  try {
    execFileSync('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.status || 1, err: (e.stderr || e.message || '').toString().trim() };
  }
}

function probeCategory(cat) {
  if (cat === 'maestro') {
    const mcp = tryShell('claude mcp list 2>/dev/null | grep -qi maestro');
    if (!mcp.ok) return { ok: false, reason: mcp.code === 127 ? 'claude mcp list unavailable' : 'MCP server not registered' };
    const cli = tryShell('which maestro >/dev/null');
    if (!cli.ok) return { ok: false, reason: 'CLI not found' };
    return { ok: true };
  }
  if (cat === 'playwright') {
    const mcp = tryShell('claude mcp list 2>/dev/null | grep -qi playwright');
    if (!mcp.ok) return { ok: false, reason: mcp.code === 127 ? 'claude mcp list unavailable' : 'MCP server not registered' };
    const cli = tryShell('which npx >/dev/null');
    if (!cli.ok) return { ok: false, reason: 'CLI not found' };
    return { ok: true };
  }
  if (cat === 'docker') {
    const bin = tryShell('which docker >/dev/null');
    if (!bin.ok) return { ok: false, reason: 'not installed' };
    const info = tryShell('timeout 3 docker info >/dev/null 2>&1');
    if (!info.ok) return { ok: false, reason: 'daemon not running' };
    return { ok: true };
  }
  return { ok: false, reason: `unknown category: ${cat}` };
}

function probePrereqs(plans) {
  const out = [];
  for (const planPath of plans) {
    const { fm } = readPlan(planPath);
    if (!Array.isArray(fm.prerequisites)) continue;
    const taskId = taskIdOf(planPath);
    for (const pr of fm.prerequisites) {
      if (!pr || !pr.check) continue;
      let status, err;
      try {
        execFileSync('bash', ['-c', `timeout 5 bash -c '${pr.check.replace(/'/g, "'\\''")}'`], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
        status = 'pass';
      } catch (e) {
        status = e.status === 124 ? 'timeout' : 'fail';
        err = (e.stderr || e.message || '').toString().trim();
      }
      out.push({ task_id: taskId, description: pr.description || pr.check, status, blocking: Boolean(pr.blocking), fix: pr.fix || '' });
    }
  }
  return out;
}

function main() {
  const { opts } = parse(process.argv.slice(2), { repeatable: new Set(['plan']) });
  const plans = opts.plan || [];
  if (plans.length === 0) die('probe-infra', 'provide at least one --plan <path>');

  const perPlan = plans.map((p) => ({ plan: p, task_id: taskIdOf(p), ...categoriesForPlan(p) }));

  const required = new Set();
  for (const p of perPlan) for (const c of p.categories) required.add(c);

  const available = [];
  const missing = [];
  for (const cat of required) {
    const r = probeCategory(cat);
    if (r.ok) { available.push(cat); continue; }
    const impacts = perPlan
      .filter((p) => p.categories.includes(cat))
      .map((p) => ({ task_id: p.task_id, test_targets: p.test_targets }));
    missing.push({ category: cat, reason: r.reason, impacts });
  }

  const task_prerequisites = probePrereqs(plans);

  process.stdout.write(JSON.stringify({
    required: Array.from(required).sort(),
    available: available.sort(),
    missing,
    task_prerequisites,
  }, null, 2) + '\n');
}

main();
