'use strict';

// Schema-aware merger for phase-settle integration.
//
// Each schema knows how to merge two-or-more competing copies of a
// single state file (the "base", "ours", "theirs" tuple becomes a
// reduce over an N-way list). The merger does NOT use git's text merge —
// for class-1 state files we have structured rules:
//
//   - Lists: union by some identifier key (or set semantics).
//   - Status fields: defined precedence (done > in-flight > ready > deferred).
//   - Counts: recompute from sources, never merge cached values.
//   - Timestamps: max wins.
//
// settle-phase.js calls into this for *.json and *-plan.md frontmatter.

const fs = require('fs');
const path = require('path');
const yaml = require('../../lib/yaml');

const PLAN_STATUS_PRECEDENCE = ['deferred', 'ready', 'in-flight', 'done'];

function maxStatus(a, b) {
  const ai = PLAN_STATUS_PRECEDENCE.indexOf(a);
  const bi = PLAN_STATUS_PRECEDENCE.indexOf(b);
  if (ai === -1 && bi === -1) return a; // unknown values left as-is
  if (ai === -1) return b;
  if (bi === -1) return a;
  return ai >= bi ? a : b;
}

function maxTimestamp(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function unionByKey(arrays, keyFn) {
  const seen = new Map();
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const k = keyFn(item);
      if (!seen.has(k)) seen.set(k, item);
    }
  }
  return Array.from(seen.values());
}

function unionScalars(arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!seen.has(item)) { seen.add(item); out.push(item); }
    }
  }
  return out;
}

// Merge plan frontmatter across N copies. The plan body itself is opaque —
// settle-phase falls back to git merge for the body and only uses this for
// the frontmatter map.
function mergePlanFrontmatter(copies) {
  if (copies.length === 0) return {};
  const out = { ...copies[0] };
  for (const fm of copies.slice(1)) {
    if (!fm) continue;
    if (fm.status !== undefined) out.status = maxStatus(out.status, fm.status);
    if (fm.deferred_at !== undefined) out.deferred_at = maxTimestamp(out.deferred_at, fm.deferred_at);
    if (fm.completed_at !== undefined) out.completed_at = maxTimestamp(out.completed_at, fm.completed_at);
    if (Array.isArray(fm.files_owned)) out.files_owned = unionScalars([out.files_owned, fm.files_owned]);
    if (Array.isArray(fm.files_readonly)) out.files_readonly = unionScalars([out.files_readonly, fm.files_readonly]);
    if (Array.isArray(fm.depends_on)) out.depends_on = unionScalars([out.depends_on, fm.depends_on]);
    // Other scalar fields: last-write-wins (the second copy's value).
    for (const k of Object.keys(fm)) {
      if (['status', 'deferred_at', 'completed_at', 'files_owned', 'files_readonly', 'depends_on'].includes(k)) continue;
      if (fm[k] !== undefined) out[k] = fm[k];
    }
  }
  return out;
}

function mergePlanFile(copies) {
  // copies: array of { frontmatter, body }
  const fmList = copies.map((c) => c.frontmatter || {});
  const mergedFm = mergePlanFrontmatter(fmList);
  // Body: take the first non-empty body; settle-phase escalates to git merge
  // if bodies differ in ways the schema doesn't recognize.
  const body = copies.find((c) => c.body && c.body.trim())?.body || (copies[0] && copies[0].body) || '';
  return { frontmatter: mergedFm, body };
}

// Merge sprint.json across copies. tasks merges by ID with status precedence.
const SPRINT_TASK_STATUS_PRECEDENCE = ['pending', 'in_progress', 'blocked', 'stuck', 'human_needed', 'done'];
function maxSprintTaskStatus(a, b) {
  const ai = SPRINT_TASK_STATUS_PRECEDENCE.indexOf(a);
  const bi = SPRINT_TASK_STATUS_PRECEDENCE.indexOf(b);
  if (ai === -1 && bi === -1) return a;
  if (ai === -1) return b;
  if (bi === -1) return a;
  return ai >= bi ? a : b;
}

function mergeSprintJson(copies) {
  if (copies.length === 0) return {};
  const out = JSON.parse(JSON.stringify(copies[0]));
  for (const c of copies.slice(1)) {
    if (!c) continue;
    if (c.sprint && (!out.sprint || c.sprint.status === 'complete')) {
      // 'complete' wins over 'active'.
      out.sprint = c.sprint.status === 'complete' ? c.sprint : (out.sprint || c.sprint);
    }
    if (c.tasks && typeof c.tasks === 'object') {
      out.tasks = out.tasks || {};
      for (const [id, t] of Object.entries(c.tasks)) {
        if (!out.tasks[id]) {
          out.tasks[id] = t;
        } else {
          const prev = out.tasks[id];
          out.tasks[id] = {
            ...prev,
            ...t,
            status: maxSprintTaskStatus(prev.status, t.status),
            verdict_at: maxTimestamp(prev.verdict_at, t.verdict_at),
          };
        }
      }
    }
  }
  return out;
}

// Read multiple copies of the same path from different worktrees.
function readPlanCopies(absPaths) {
  return absPaths.map((p) => {
    if (!fs.existsSync(p)) return { frontmatter: {}, body: '' };
    return yaml.splitFrontmatter(fs.readFileSync(p, 'utf8'));
  });
}

function readJsonCopies(absPaths) {
  return absPaths.map((p) => {
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

module.exports = {
  PLAN_STATUS_PRECEDENCE,
  maxStatus,
  maxTimestamp,
  unionByKey,
  unionScalars,
  mergePlanFrontmatter,
  mergePlanFile,
  mergeSprintJson,
  readPlanCopies,
  readJsonCopies,
};
