'use strict';

// Internal API for human-review-queue.md manipulation. The CLI in
// scripts/state/review-queue.js is a thin wrapper over these functions.
//
// File shape:
//   ---
//   pending_count: N
//   items: []           # legacy; body is authoritative
//   ---
//
//   # Human Review Queue
//
//   - task: TASK-NNN
//     type: action_required
//     ...
//
//   - task: ...
//     ...
//
// Entries are a YAML block list in the body. Empty queue shows
// `No items pending review.` instead of any list items.

const fs = require('fs');
const yaml = require('./yaml');
const { writeAtomic } = require('./fs-atomic');

const HEADING = '# Human Review Queue';
const EMPTY_BODY_MSG = 'No items pending review.';

function parseFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { frontmatter: { pending_count: 0, items: [] }, entries: [], headingPresent: false };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = yaml.splitFrontmatter(text);
  const fm = frontmatter || {};
  const idx = body.indexOf(HEADING);
  const afterHeading = idx === -1 ? body : body.slice(idx + HEADING.length);
  // Strip leading blank lines / the placeholder.
  const stripped = afterHeading.replace(/^\s*(No items pending review\.\s*)?/s, '').trimStart();
  let entries = [];
  if (stripped.length > 0) {
    try { entries = yaml.parse(stripped) || []; }
    catch (e) { throw new Error(`queue body is not valid YAML: ${e.message}`); }
    if (!Array.isArray(entries)) entries = [];
  }
  return { frontmatter: fm, entries, headingPresent: idx !== -1 };
}

function serializeEntry(entry) {
  // Serialize one entry as a YAML list item. All body lines end up at col 2;
  // nested list items at col 4 (standard indented block-sequence style).
  const keys = Object.keys(entry);
  if (keys.length === 0) return '- {}';
  const fieldLines = keys
    .map((k) => renderField(k, entry[k]))
    .join('\n')
    .split('\n');
  return '- ' + fieldLines[0] + (fieldLines.length > 1
    ? '\n' + fieldLines.slice(1).map((l) => '  ' + l).join('\n')
    : '');
}

function renderField(key, val) {
  if (val === null || val === undefined) return `${key}: null`;
  if (typeof val === 'boolean' || typeof val === 'number') return `${key}: ${val}`;
  if (typeof val === 'string') return `${key}: ${quote(val)}`;
  if (Array.isArray(val)) {
    if (val.length === 0) return `${key}: []`;
    const itemBodies = val.map((v) => {
      if (v === null || typeof v !== 'object') {
        return typeof v === 'string' ? quote(v) : String(v);
      }
      const inner = Object.keys(v).map((kk) => renderField(kk, v[kk])).join('\n').split('\n');
      return inner[0] + (inner.length > 1 ? '\n' + inner.slice(1).map((l) => '  ' + l).join('\n') : '');
    });
    return `${key}:\n` + itemBodies.map((b) => '  - ' + b).join('\n');
  }
  // Nested object.
  const innerLines = Object.keys(val).map((k) => renderField(k, val[k])).join('\n').split('\n');
  return `${key}:\n` + innerLines.map((l) => '  ' + l).join('\n');
}

function quote(s) {
  if (s === '') return '""';
  // Quote when the value could be ambiguous (contains : # - { etc. or starts with special).
  if (/^[-*?|>!%@`&]/.test(s) || /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
      /^-?\d/.test(s) || /[:#\[\]{},&*!|>'"\n]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return s;
}

function serializeQueue(entries) {
  if (entries.length === 0) return EMPTY_BODY_MSG + '\n';
  return entries.map(serializeEntry).join('\n\n') + '\n';
}

function rewrite(filePath, entries, extraFrontmatter = {}) {
  const pending = entries.filter((e) => !e || e.type !== 'overridden').length;
  const fm = { pending_count: pending, items: [], ...extraFrontmatter };
  const body = '\n' + HEADING + '\n\n' + serializeQueue(entries);
  const out = yaml.joinFrontmatter(fm, body);
  writeAtomic(filePath, out);
  return pending;
}

function appendEntry(filePath, entry) {
  const state = parseFile(filePath);
  state.entries.push(entry);
  return rewrite(filePath, state.entries);
}

function removeEntries(filePath, predicate) {
  const state = parseFile(filePath);
  const before = state.entries.length;
  const kept = state.entries.filter((e) => !predicate(e));
  const removed = before - kept.length;
  rewrite(filePath, kept);
  return removed;
}

function overrideEntry(filePath, predicate, justification) {
  const state = parseFile(filePath);
  const now = new Date().toISOString();
  let count = 0;
  for (const e of state.entries) {
    if (predicate(e)) {
      e.type = 'overridden';
      e.override = justification;
      e.override_at = now;
      count++;
    }
  }
  rewrite(filePath, state.entries);
  return count;
}

function severityRank(sev) {
  if (sev === 'high') return 3;
  if (sev === 'medium' || sev == null) return 2;
  if (sev === 'low') return 1;
  return 0;
}

function gather(filePath) {
  const { entries } = parseFile(filePath);
  const actionRequired = [];
  const actionRequiredVisual = [];
  const sprintCodeReview = [];
  const configIssue = [];
  const overridden = [];
  const other = [];
  const malformed = [];

  for (const e of entries) {
    if (!e || typeof e !== 'object') { malformed.push(e); continue; }
    if (e.type === 'action_required' && e.level === 'visual') actionRequiredVisual.push(e);
    else if (e.type === 'action_required') actionRequired.push(e);
    else if (e.type === 'sprint_code_review') sprintCodeReview.push(e);
    else if (e.type === 'config_issue') configIssue.push(e);
    else if (e.type === 'overridden') overridden.push(e);
    else other.push(e);
  }

  const sortBySev = (a, b) => severityRank(b.severity) - severityRank(a.severity);
  actionRequired.sort(sortBySev);
  actionRequiredVisual.sort(sortBySev);
  sprintCodeReview.sort(sortBySev);

  const pendingCount = entries.filter((e) => e && e.type !== 'overridden').length;
  return {
    entries,
    action_required: actionRequired,
    action_required_visual: actionRequiredVisual,
    sprint_code_review: sprintCodeReview,
    config_issue: configIssue,
    overridden,
    other,
    malformed,
    pending_count: pendingCount,
  };
}

function groupByAction(entries) {
  // Used in sprint-closer: group action_required by `action` text, max severity.
  const groups = new Map();
  for (const e of entries) {
    if (!e || e.type !== 'action_required') continue;
    const key = e.action || '(no action text)';
    if (!groups.has(key)) groups.set(key, { action: key, severity: 'low', blocked_checks: [], task_ids: [] });
    const g = groups.get(key);
    if (severityRank(e.severity) > severityRank(g.severity)) g.severity = e.severity || 'medium';
    if (Array.isArray(e.blocked_checks)) for (const bc of e.blocked_checks) if (!g.blocked_checks.includes(bc)) g.blocked_checks.push(bc);
    if (e.task && !g.task_ids.includes(e.task)) g.task_ids.push(e.task);
  }
  return Array.from(groups.values());
}

module.exports = { parseFile, appendEntry, removeEntries, overrideEntry, gather, groupByAction, rewrite, serializeEntry };
