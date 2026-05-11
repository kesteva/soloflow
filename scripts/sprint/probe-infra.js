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
const config = require('../lib/config');
const { parse, die } = require('../lib/args');
const shadowAgents = require('../init/shadow-agents');

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

function tryShell(cmd, opts = {}) {
  try {
    const execOpts = { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
    if (opts.timeoutMs) execOpts.timeout = opts.timeoutMs;
    execFileSync('bash', ['-c', cmd], execOpts);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.status || 1, err: (e.stderr || e.message || '').toString().trim(), signal: e.signal };
  }
}

function probeCategory(cat) {
  if (cat === 'maestro') {
    // Maestro runs MCP-first with CLI fallback since 0.9.7. Either path
    // is sufficient at preflight — the verifier's Path Selection picks
    // one at run-time. Simulator/emulator availability is probed at
    // verifier run-time (not preflight), since users commonly boot
    // their device right before a sprint starts.
    const mcp = tryShell('claude mcp list 2>/dev/null | grep -qi maestro');
    const cli = tryShell('which maestro >/dev/null');
    if (mcp.ok && cli.ok) return { ok: true };
    if (mcp.ok && !cli.ok) return { ok: true, reason: 'MCP registered; CLI not found (fallback unavailable)' };
    if (!mcp.ok && cli.ok) return { ok: true, reason: 'CLI present; MCP not registered (fallback only)' };
    return { ok: false, reason: 'neither MCP nor CLI available' };
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
    const info = tryShell('docker info >/dev/null 2>&1', { timeoutMs: 3000 });
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
        execFileSync('bash', ['-c', pr.check], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
        status = 'pass';
      } catch (e) {
        status = (e.signal === 'SIGTERM' || e.signal === 'SIGKILL') ? 'timeout' : 'fail';
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
  const configDriven = new Set();
  for (const p of perPlan) for (const c of p.categories) required.add(c);

  // Config toggles demand the MCP regardless of plan content — the verifier's
  // Level 2 decision gate fires for any UI file or UI-visible AC, not just
  // integration tests.
  if (config.resolve('verification.visual_mobile', false) === true) {
    required.add('maestro');
    configDriven.add('maestro');
  }
  if (config.resolve('verification.visual_web', false) === true) {
    required.add('playwright');
    configDriven.add('playwright');
  }

  const available = [];
  const missing = [];
  for (const cat of required) {
    const r = probeCategory(cat);
    if (r.ok) { available.push(cat); continue; }
    const impacts = perPlan
      .filter((p) => p.categories.includes(cat))
      .map((p) => ({ task_id: p.task_id, test_targets: p.test_targets }));
    const reason = configDriven.has(cat)
      ? `${r.reason} (required by verification.visual_${cat === 'maestro' ? 'mobile' : 'web'}=true)`
      : r.reason;
    missing.push({ category: cat, reason, impacts });
  }

  // Shadow-install cross-check for Playwright and Maestro.
  //
  // `claude mcp list` only confirms the MCP server is registered — it doesn't
  // guarantee `mcp__{playwright,maestro}__*` tool bindings reach the shadow-
  // verifier subagent session. That propagation depends on the shadow agents
  // at .claude/agents/shadow-verifier.md and shadow-sprint-verifier.md.
  //
  // Playwright has no CLI fallback — broken shadows silently degrade every
  // task to `skipped_unable`. Demote unconditionally when shadows are broken.
  //
  // Maestro has a CLI fallback (since 0.9.7). Broken shadows only degrade to
  // CLI mode, which is still functional. Only demote when shadows are broken
  // AND the CLI is also unavailable — otherwise the fallback absorbs the gap
  // silently. (We still preserve Maestro's probeCategory reason when it
  // indicates MCP isn't registered — in that case the fallback is the only
  // path and the shadow cross-check is moot anyway.)
  if (configDriven.has('playwright') || configDriven.has('maestro')) {
    let shadowState = null;
    try { shadowState = shadowAgents.check(); } catch { /* shadow module unavailable */ }
    if (shadowState) {
      const visualSet = shadowState.shadows.filter((s) => s.name === 'shadow-verifier.md' || s.name === 'shadow-sprint-verifier.md');
      const broken = visualSet.filter((s) => s.status !== 'current');
      if (broken.length > 0) {
        const brokenDesc = broken.map((s) => `${s.name}=${s.status}`).join(', ');
        const demote = (category, toolPrefix, tailMsg) => {
          const shadowReason = `shadow agents not current (${brokenDesc}) — ${toolPrefix} bindings will not reach shadow-verifier subagent session. Run /soloflow:sync-agents to install/update shadows.${tailMsg}`;
          const availIdx = available.indexOf(category);
          if (availIdx >= 0) {
            available.splice(availIdx, 1);
            const planImpacts = perPlan
              .filter((p) => p.categories.includes(category))
              .map((p) => ({ task_id: p.task_id, test_targets: p.test_targets }));
            const impacts = planImpacts.length > 0
              ? planImpacts
              : perPlan.map((p) => ({ task_id: p.task_id, test_targets: [] }));
            missing.push({ category, reason: shadowReason, impacts });
          } else {
            const existing = missing.find((m) => m.category === category);
            if (existing) existing.reason = `${existing.reason}; ${shadowReason}`;
          }
        };
        if (configDriven.has('playwright')) {
          demote('playwright', 'mcp__playwright__*', ' (required by verification.visual_web=true)');
        }
        if (configDriven.has('maestro')) {
          const cli = tryShell('which maestro >/dev/null');
          if (!cli.ok) {
            demote('maestro', 'mcp__maestro__*', ' AND `maestro` CLI not installed — no fallback (required by verification.visual_mobile=true)');
          }
          // If CLI is present, broken shadows are tolerable: verifier falls
          // back to CLI mode silently. Deliberately do not warn on that case.
        }
      }
    }
  }

  const task_prerequisites = probePrereqs(plans);

  // Non-blocking advisories surfaced at orchestrator Step 2.8 alongside the
  // task-level infra surface. Inform-only — never gate or prompt.
  const advisories = [];
  if (configDriven.has('maestro') && config.resolve('verification.visual_auth_fixture', null) === null) {
    advisories.push({
      category: 'maestro',
      kind: 'no_auth_fixture',
      message: 'verification.visual_mobile=true but visual_auth_fixture is unset. Signed-out simulator runs will deduplicate to a single queue entry (dedup_key: simulator_unauthenticated). Consider creating .maestro/fixtures/sign-in.yaml and setting verification.visual_auth_fixture.',
    });
  }

  process.stdout.write(JSON.stringify({
    required: Array.from(required).sort(),
    available: available.sort(),
    missing,
    advisories,
    task_prerequisites,
  }, null, 2) + '\n');
}

main();
