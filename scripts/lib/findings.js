'use strict';

// Internal API for per-sprint findings files
// (.soloflow/active/findings/{sprint_id}-findings.md).
//
// File shape:
//   ---
//   sprint: SPRINT-NNN
//   pending_count: N
//   last_updated: <ISO or null>
//   ---
//
//   # Findings Queue
//
//   ## FIND-<sprint>-<n>
//   - **source:** TASK-NNN (executor)
//   - **type:** bug
//   - **severity:** medium
//   - **status:** open
//   - **location:** path/to/file.ext:line
//   - **description:** one paragraph
//   - **suggested_action:** (optional)
//   - **resolved_by:**
//
//   ## FIND-...
//   ...
//
// Entries are parsed / mutated via regex on the canonical `- **key:** value`
// format. Freeform paragraphs between entries are preserved as "prelude" text
// on the following entry so round-trip writes don't lose content.

const fs = require('fs');
const yaml = require('./yaml');
const { writeAtomic, writeExclusive } = require('./fs-atomic');

const HEADING = '# Findings Queue';
const FIELD_RE = /^- \*\*(\w+):\*\*\s?(.*)$/;

function ensureExists(filePath, sprintId) {
  const content = `---
sprint: ${sprintId}
pending_count: 0
last_updated: null
---

${HEADING}
`;
  // Use writeExclusive so a resume call doesn't clobber.
  const created = writeExclusive(filePath, content);
  return created;
}

function parseFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { frontmatter: null, entries: [], body: '', missing: true };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = yaml.splitFrontmatter(raw);
  // Split body on ## FIND- headings.
  const lines = body.split(/\r?\n/);
  const entries = [];
  let current = null;
  let preBody = [];

  for (const line of lines) {
    const h = line.match(/^##\s+(FIND-\S+)\s*$/);
    if (h) {
      if (current) entries.push(current);
      current = { id: h[1], fields: {}, fieldOrder: [], trailing: [] };
      continue;
    }
    if (!current) {
      // Drop the canonical heading line — it's always re-emitted on write.
      if (line.trim() === HEADING) continue;
      preBody.push(line);
      continue;
    }
    const m = line.match(FIELD_RE);
    if (m) {
      current.fields[m[1]] = m[2];
      current.fieldOrder.push(m[1]);
    } else {
      current.trailing.push(line);
    }
  }
  if (current) entries.push(current);

  // Strip leading/trailing blank lines from preBody.
  while (preBody.length && preBody[0].trim() === '') preBody.shift();
  while (preBody.length && preBody[preBody.length - 1].trim() === '') preBody.pop();

  return { frontmatter: frontmatter || {}, entries, preBody: preBody.join('\n') };
}

function serialize(fm, preBody, entries) {
  const sections = [];
  if (preBody && preBody.trim() !== '') sections.push(preBody.replace(/\s+$/, ''));
  for (const e of entries) {
    const lines = [`## ${e.id}`];
    for (const k of e.fieldOrder) {
      const v = e.fields[k];
      lines.push(`- **${k}:** ${v == null ? '' : v}`);
    }
    if (e.trailing && e.trailing.length) {
      const trailing = e.trailing.slice();
      while (trailing.length && trailing[trailing.length - 1].trim() === '') trailing.pop();
      if (trailing.length) { lines.push(''); lines.push(...trailing); }
    }
    sections.push(lines.join('\n'));
  }
  const body = '\n' + HEADING + '\n\n' + sections.join('\n\n') + '\n';
  return yaml.joinFrontmatter(fm, body);
}

function countPending(entries) {
  return entries.filter((e) => (e.fields.status || '').trim() === 'open').length;
}

function refreshFrontmatter(fm, entries) {
  fm.pending_count = countPending(entries);
  fm.last_updated = new Date().toISOString();
  return fm;
}

function appendEntry(filePath, entry) {
  // entry: { id, fields: { source, type, severity, status, location, description, suggested_action?, resolved_by? } }
  const state = parseFile(filePath);
  if (state.missing) throw new Error(`findings file not found: ${filePath} (call ensureExists first)`);
  const fieldOrder = entry.fieldOrder || Object.keys(entry.fields);
  state.entries.push({ id: entry.id, fields: entry.fields, fieldOrder, trailing: [] });
  refreshFrontmatter(state.frontmatter, state.entries);
  writeAtomic(filePath, serialize(state.frontmatter, state.preBody, state.entries));
  return state.frontmatter.pending_count;
}

function setStatus(filePath, findId, status, resolvedBy = null) {
  const state = parseFile(filePath);
  if (state.missing) throw new Error(`findings file not found: ${filePath}`);
  const e = state.entries.find((x) => x.id === findId);
  if (!e) throw new Error(`finding not found: ${findId}`);
  e.fields.status = status;
  if (!e.fieldOrder.includes('status')) e.fieldOrder.push('status');
  if (resolvedBy != null) {
    e.fields.resolved_by = resolvedBy;
    if (!e.fieldOrder.includes('resolved_by')) e.fieldOrder.push('resolved_by');
  }
  refreshFrontmatter(state.frontmatter, state.entries);
  writeAtomic(filePath, serialize(state.frontmatter, state.preBody, state.entries));
  return state.frontmatter.pending_count;
}

function reconcile(filePath, doneReportPath) {
  // Parse the done report body for any "**Findings resolved:**" line. Extract
  // FIND IDs, flip matching entries from open → resolved with a sprint-closer
  // attribution. Returns { reconciled: [FIND-ID, ...], skipped: [{id, reason}] }.
  if (!fs.existsSync(doneReportPath)) throw new Error(`done report not found: ${doneReportPath}`);
  const drText = fs.readFileSync(doneReportPath, 'utf8');
  const { frontmatter: drFm } = yaml.splitFrontmatter(drText);
  const taskId = (drFm && drFm.id) || null;

  const line = (drText.match(/^\s*-?\s*\*\*Findings resolved:\*\*\s*(.*)$/m) || [])[1] || '';
  const findIds = Array.from(line.matchAll(/FIND-[A-Za-z0-9_-]+/g)).map((m) => m[0]);
  if (findIds.length === 0) return { reconciled: [], skipped: [], task_id: taskId };

  const state = parseFile(filePath);
  if (state.missing) return { reconciled: [], skipped: findIds.map((id) => ({ id, reason: 'findings_file_missing' })), task_id: taskId };

  const reconciled = [];
  const skipped = [];
  for (const id of findIds) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) { skipped.push({ id, reason: 'not_in_findings' }); continue; }
    if ((e.fields.status || '').trim() !== 'open') { skipped.push({ id, reason: `already_${e.fields.status}` }); continue; }
    e.fields.status = 'resolved';
    e.fields.resolved_by = taskId ? `${taskId} (sprint-closer status-sync)` : '(sprint-closer status-sync)';
    if (!e.fieldOrder.includes('resolved_by')) e.fieldOrder.push('resolved_by');
    reconciled.push(id);
  }
  if (reconciled.length) {
    refreshFrontmatter(state.frontmatter, state.entries);
    writeAtomic(filePath, serialize(state.frontmatter, state.preBody, state.entries));
  }
  return { reconciled, skipped, task_id: taskId, pending_count: state.frontmatter.pending_count };
}

function recompute(filePath) {
  const state = parseFile(filePath);
  if (state.missing) throw new Error(`findings file not found: ${filePath}`);
  refreshFrontmatter(state.frontmatter, state.entries);
  writeAtomic(filePath, serialize(state.frontmatter, state.preBody, state.entries));
  return state.frontmatter.pending_count;
}

module.exports = { ensureExists, parseFile, appendEntry, setStatus, reconcile, recompute };
