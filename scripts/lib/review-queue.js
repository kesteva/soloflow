'use strict';

// Internal API for human-review-queue.md manipulation. The CLI in
// scripts/state/review-queue.js is a thin wrapper over these functions.
//
// File shape (new sectioned format):
//   ---
//   pending_count: N
//   buckets:
//     decisions: N
//     actions: N
//     testing: N
//     deferred_visual: N
//   items: []           # legacy field, kept empty for back-compat
//   ---
//
//   # Human Review Queue
//
//   ## Decisions
//
//   - task: TASK-NNN
//     type: HUMAN_NEEDED
//     ...
//
//   ## Actions
//
//   _No items._
//
//   ## Testing
//
//   - task: ...
//     ...
//
//   ## Deferred Visual
//
//   _No items._
//
// Legacy unsectioned format (a single YAML list directly under
// `# Human Review Queue`) is still readable; the next mutating call
// rewrites it in the sectioned form.

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');
const paths = require('./paths');
const { writeAtomic } = require('./fs-atomic');
const { withFileLock } = require('./lock');

// Lock path lives in the common gitdir so concurrent worktrees serialize on
// the same lock. Keyed on a fixed slug; review-queue mutations are
// inherently global (one shared file).
function reviewQueueLockPath(filePath) {
  // filePath is the .soloflow/human-review-queue.md path; resolve cwd from
  // its parent's parent (cwd/.soloflow).
  const stateDir = path.dirname(filePath);
  const cwd = path.dirname(stateDir);
  return path.join(paths.commonGitDir(cwd), 'soloflow-review-queue.lock');
}

function withQueueLock(filePath, fn) {
  return withFileLock(reviewQueueLockPath(filePath), fn);
}

const HEADING = '# Human Review Queue';
const EMPTY_SECTION_MSG = '_No items._';
const BUCKETS = ['decisions', 'actions', 'testing', 'deferred_visual'];
const BUCKET_TITLES = {
  decisions: 'Decisions',
  actions: 'Actions',
  testing: 'Testing',
  deferred_visual: 'Deferred Visual',
};
const TITLE_TO_BUCKET = {
  'Decisions': 'decisions',
  'Actions': 'actions',
  'Testing': 'testing',
  'Deferred Visual': 'deferred_visual',
};

function isBucket(b) { return BUCKETS.includes(b); }

function classifyBucket(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (isBucket(entry.bucket)) return entry.bucket;
  // Legacy fallback: infer from type / level / action verb.
  const t = entry.type;
  if (t === 'overridden') return null; // overridden is a marker, not a bucket
  if (t === 'HUMAN_NEEDED') return 'decisions';
  if (t === 'investigation_inconclusive') return 'decisions';
  if (t === 'merge-conflict') return 'actions';
  if (t === 'config_issue') return 'actions';
  if (t === 'visual_failure') return 'deferred_visual';
  if (t === 'action_required') {
    if (entry.level === 'visual') return 'testing';
    const action = typeof entry.action === 'string' ? entry.action.trim().toLowerCase() : '';
    // Verbs that signal "human verifies" land in testing; everything else → actions.
    if (/^(verify|confirm|check|open|test|inspect|observe|reproduce)\b/.test(action)) {
      return 'testing';
    }
    return 'actions';
  }
  // Unknown type — surface as decisions so it isn't lost.
  return 'decisions';
}

function parseFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      frontmatter: { pending_count: 0, buckets: emptyBucketCounts(), items: [] },
      entries: [],
      headingPresent: false,
    };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = yaml.splitFrontmatter(text);
  const fm = frontmatter || {};
  const idx = body.indexOf(HEADING);
  const afterHeading = idx === -1 ? body : body.slice(idx + HEADING.length);
  const entries = parseSections(afterHeading);
  return { frontmatter: fm, entries, headingPresent: idx !== -1 };
}

function parseSections(afterHeading) {
  // Split on `## ` subheadings. If none present, treat the whole region
  // as a legacy unsectioned list and bucket via classifyBucket().
  const sectionRe = /\n##\s+([^\n]+)\n/g;
  const matches = [];
  let m;
  while ((m = sectionRe.exec(afterHeading)) !== null) {
    matches.push({ title: m[1].trim(), bodyStart: m.index + m[0].length, headingStart: m.index });
  }
  if (matches.length === 0) {
    // Legacy: parse the entire region as a single YAML list.
    const stripped = afterHeading.replace(/^\s*(No items pending review\.\s*)?/s, '').trimStart();
    const items = parseYamlList(stripped);
    return items.map(stampLegacyBucket);
  }
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const sectionBody = afterHeading.slice(cur.bodyStart, next ? next.headingStart : afterHeading.length);
    const bucket = TITLE_TO_BUCKET[cur.title] || null;
    const items = parseYamlList(sectionBody);
    for (const it of items) {
      if (it && typeof it === 'object') {
        if (bucket) it.bucket = bucket;
        else if (!isBucket(it.bucket)) it.bucket = classifyBucket(it);
      }
      out.push(it);
    }
  }
  return out;
}

function parseYamlList(text) {
  const stripped = text
    .replace(/^\s*(_No items\._\s*)?/s, '')
    .replace(/^\s*(No items pending review\.\s*)?/s, '')
    .trimStart();
  if (stripped.length === 0) return [];
  let parsed;
  try { parsed = yaml.parse(stripped) || []; }
  catch (e) { throw new Error(`queue body is not valid YAML: ${e.message}`); }
  return Array.isArray(parsed) ? parsed : [];
}

function stampLegacyBucket(it) {
  if (!it || typeof it !== 'object') return it;
  if (!isBucket(it.bucket)) it.bucket = classifyBucket(it) || 'decisions';
  return it;
}

function emptyBucketCounts() {
  return { decisions: 0, actions: 0, testing: 0, deferred_visual: 0 };
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

function serializeSection(title, entries) {
  const head = '## ' + title + '\n\n';
  if (entries.length === 0) return head + EMPTY_SECTION_MSG + '\n';
  return head + entries.map(serializeEntry).join('\n\n') + '\n';
}

function serializeQueueSectioned(grouped) {
  // grouped: { decisions: [], actions: [], testing: [], deferred_visual: [], overridden: [] }
  const sections = BUCKETS.map((b) => serializeSection(BUCKET_TITLES[b], grouped[b] || []));
  // Overridden entries are kept in the file (soft-delete) but rendered after
  // the four buckets under a hidden-by-convention heading so they don't
  // disappear from `parseFile()` round-trips.
  const overridden = grouped.overridden || [];
  if (overridden.length > 0) {
    sections.push('## Overridden\n\n' + overridden.map(serializeEntry).join('\n\n') + '\n');
  }
  return sections.join('\n');
}

function groupEntriesForWrite(entries) {
  const out = { overridden: [] };
  for (const b of BUCKETS) out[b] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'overridden') { out.overridden.push(e); continue; }
    const b = classifyBucket(e) || 'decisions';
    e.bucket = b;
    out[b].push(e);
  }
  return out;
}

function rewrite(filePath, entries, extraFrontmatter = {}) {
  const grouped = groupEntriesForWrite(entries);
  const counts = emptyBucketCounts();
  for (const b of BUCKETS) counts[b] = grouped[b].length;
  const pending = BUCKETS.reduce((n, b) => n + counts[b], 0);
  const fm = { pending_count: pending, buckets: counts, items: [], ...extraFrontmatter };
  const body = '\n' + HEADING + '\n\n' + serializeQueueSectioned(grouped);
  const out = yaml.joinFrontmatter(fm, body);
  writeAtomic(filePath, out);
  return pending;
}

async function appendEntry(filePath, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('appendEntry: entry must be an object');
  }
  if (!isBucket(entry.bucket)) {
    const inferred = classifyBucket(entry);
    if (!inferred) {
      throw new Error('appendEntry: entry is missing required `bucket` field (decisions|actions|testing|deferred_visual) and could not be inferred');
    }
    entry.bucket = inferred;
  }
  return withQueueLock(filePath, () => {
    const state = parseFile(filePath);
    state.entries.push(entry);
    return rewrite(filePath, state.entries);
  });
}

async function removeEntries(filePath, predicate) {
  return withQueueLock(filePath, () => {
    const state = parseFile(filePath);
    const before = state.entries.length;
    const kept = state.entries.filter((e) => !predicate(e));
    const removed = before - kept.length;
    rewrite(filePath, kept);
    return removed;
  });
}

async function overrideEntry(filePath, predicate, justification) {
  return withQueueLock(filePath, () => {
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
  });
}

function severityRank(sev) {
  if (sev === 'high') return 3;
  if (sev === 'medium' || sev == null) return 2;
  if (sev === 'low') return 1;
  return 0;
}

function gather(filePath) {
  const { entries } = parseFile(filePath);
  const result = {
    entries,
    decisions: [],
    actions: [],
    testing: [],
    deferred_visual: [],
    overridden: [],
    malformed: [],
  };

  for (const e of entries) {
    if (!e || typeof e !== 'object') { result.malformed.push(e); continue; }
    if (e.type === 'overridden') { result.overridden.push(e); continue; }
    const b = classifyBucket(e);
    if (b && result[b]) {
      // Stamp the bucket back onto the entry so consumers see consistent state.
      e.bucket = b;
      result[b].push(e);
    } else {
      result.malformed.push(e);
    }
  }

  const sortBySev = (a, b) => severityRank(b.severity) - severityRank(a.severity);
  for (const b of BUCKETS) result[b].sort(sortBySev);

  const pendingCount = entries.filter((e) => e && e.type !== 'overridden').length;
  const buckets = emptyBucketCounts();
  for (const b of BUCKETS) buckets[b] = result[b].length;
  result.pending_count = pendingCount;
  result.buckets = buckets;
  return result;
}

function groupByAction(entries) {
  // Group entries by `action` text (max severity, merged blocked_checks). Used
  // by sprint orchestrator end-of-sprint review and review-queue triage.
  const groups = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const key = e.action || '(no action text)';
    if (!groups.has(key)) groups.set(key, { action: key, severity: 'low', blocked_checks: [], task_ids: [], bucket: e.bucket });
    const g = groups.get(key);
    if (severityRank(e.severity) > severityRank(g.severity)) g.severity = e.severity || 'medium';
    if (Array.isArray(e.blocked_checks)) for (const bc of e.blocked_checks) if (!g.blocked_checks.includes(bc)) g.blocked_checks.push(bc);
    if (e.task && !g.task_ids.includes(e.task)) g.task_ids.push(e.task);
  }
  return Array.from(groups.values());
}

module.exports = {
  parseFile,
  appendEntry,
  removeEntries,
  overrideEntry,
  gather,
  groupByAction,
  rewrite,
  serializeEntry,
  classifyBucket,
  BUCKETS,
};
