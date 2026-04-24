#!/usr/bin/env node
'use strict';

// Replicates sprint-closer.md Phase 1 (gather) without an LLM agent spawn.
// Reads .soloflow/ state, tallies stats, reconciles findings against done
// reports, computes compound-proposal archive paths, and prints the same
// YAML payload the orchestrator consumes.
//
// Usage:
//   node close-gather.js
//
// Output: JSON on stdout matching agents/sprint-closer.md Phase 1 `Data` block.

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml');
const config = require('../lib/config');
const paths = require('../lib/paths');
const rq = require('../lib/review-queue');
const findingsLib = require('../lib/findings');

function die(msg, code = 1) {
  process.stderr.write(`close-gather: ${msg}\n`);
  process.exit(code);
}

function globRecursive(root, matcher) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && matcher(e.name, p)) out.push(p);
    }
  }
  return out;
}

function readFm(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return yaml.splitFrontmatter(raw);
  } catch { return { frontmatter: null, body: '' }; }
}

function firstNonEmptyLine(text) {
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    if (t && !t.startsWith('---')) return t;
  }
  return '';
}

function severityRank(s) {
  return s === 'high' ? 3 : s === 'low' ? 1 : 2;
}

function severityMax(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function tallyVisualCoverage(doneReports, sprintId) {
  const init = () => ({ pass: 0, fail: 0, not_applicable: 0, skipped_user_preference: 0, skipped_unable: 0 });
  const mobile = init();
  const web = init();
  for (const dr of doneReports) {
    const { frontmatter: fm } = readFm(dr);
    if (!fm || fm.sprint !== sprintId) continue;
    const m = (fm.visual_mobile || 'not_applicable');
    const w = (fm.visual_web || 'not_applicable');
    if (mobile[m] !== undefined) mobile[m]++; else mobile.not_applicable++;
    if (web[w] !== undefined) web[w]++; else web.not_applicable++;
  }
  return { mobile, web };
}

function main() {
  const cwd = process.cwd();
  const sprintPath = paths.sprintJsonPath(cwd);
  if (!fs.existsSync(sprintPath)) die('no active sprint (sprint.json missing)');

  let state;
  try { state = JSON.parse(fs.readFileSync(sprintPath, 'utf8')); }
  catch (e) { die(`sprint.json invalid: ${e.message}`); }
  if (!state.sprint || !state.sprint.id) die('sprint.json has no sprint.id');

  const sprintId = state.sprint.id;

  // 1. Collect done reports for this sprint.
  const doneRoot = path.join(paths.archiveDir(cwd), 'done');
  const allDone = globRecursive(doneRoot, (name) => /^TASK-\d+-done\.md$/.test(name));
  const completedTasks = [];
  let totalExecutorLoops = 0;
  let totalCodeReviewRounds = 0;
  const doneReportPaths = [];
  for (const dr of allDone) {
    const parsed = readFm(dr);
    const fm = parsed.frontmatter;
    if (!fm || fm.sprint !== sprintId) continue;
    doneReportPaths.push(dr);
    let summary = fm.summary;
    if (!summary) summary = firstNonEmptyLine(parsed.body);
    totalExecutorLoops += Number(fm.executor_loops || 0);
    totalCodeReviewRounds += Number(fm.code_review_rounds || 0);
    completedTasks.push({ id: fm.id, epic: fm.epic || null, summary: summary || '' });
  }

  // 2. Stuck reports.
  const stuckRoot = path.join(paths.activeDir(cwd), 'stuck');
  const allStuck = globRecursive(stuckRoot, (name) => /^TASK-\d+-stuck\.md$/.test(name));
  const stuckTasks = [];
  for (const sr of allStuck) {
    const parsed = readFm(sr);
    const fm = parsed.frontmatter || {};
    if (fm.sprint && fm.sprint !== sprintId) continue;
    totalExecutorLoops += Number(fm.executor_loops || 0);
    const failure = fm.failure || firstNonEmptyLine(parsed.body);
    const attempted = fm.attempted || '';
    stuckTasks.push({ id: fm.id || (path.basename(sr).match(/^TASK-(\d+)-stuck/) || [null, null])[1], epic: fm.epic || null, failure, attempted });
  }

  // 3. Sprint tasks — human_needed / blocked.
  const remainingTasks = state.tasks || {};
  const humanNeeded = [];
  const blocked = [];
  for (const [id, t] of Object.entries(remainingTasks)) {
    if (!t) continue;
    if (t.status === 'human_needed') humanNeeded.push(id);
    else if (t.status === 'blocked') blocked.push(id);
  }

  // 4. Visual coverage — per task + sprint level.
  const perTaskVisual = tallyVisualCoverage(doneReportPaths, sprintId);

  const sprintVerifPath = path.join(paths.activeDir(cwd), 'sprint-verification.md');
  let sprintLevelVisual = {
    mobile: 'not_applicable', web: 'not_applicable',
    mobile_note: 'sprint-verifier did not run', web_note: 'sprint-verifier did not run',
  };
  let regressionsCount = 0;
  if (fs.existsSync(sprintVerifPath)) {
    const { frontmatter: fm } = readFm(sprintVerifPath);
    if (fm) {
      sprintLevelVisual = {
        mobile: fm.visual_mobile || 'not_applicable',
        web: fm.visual_web || 'not_applicable',
        mobile_note: fm.visual_mobile_note || null,
        web_note: fm.visual_web_note || null,
      };
      regressionsCount = Number(fm.regressions_count || 0);
    }
  }

  const sprintCodeReviewPath = path.join(paths.activeDir(cwd), 'sprint-code-review.md');
  let sprintCodeReview = { ran: false, ran_simplify: false, ran_security_review: false, findings_count: { critical: 0, important: 0, minor: 0 } };
  if (fs.existsSync(sprintCodeReviewPath)) {
    const { frontmatter: fm } = readFm(sprintCodeReviewPath);
    if (fm) {
      const fc = (fm.findings_count && typeof fm.findings_count === 'object') ? fm.findings_count : {};
      sprintCodeReview = {
        ran: true,
        ran_simplify: Boolean(fm.ran_simplify),
        ran_security_review: Boolean(fm.ran_security_review),
        findings_count: { critical: Number(fc.critical || 0), important: Number(fc.important || 0), minor: Number(fc.minor || 0) },
      };
    }
  }

  // 5. Findings reconciliation. For each done report, find any
  //    "**Findings resolved:**" line, then check the findings file.
  const findingsPath = paths.findingsFilePath(sprintId, cwd);
  const findingsReconciliation = [];
  if (fs.existsSync(findingsPath)) {
    const { entries } = findingsLib.parseFile(findingsPath);
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const dr of doneReportPaths) {
      const drText = fs.readFileSync(dr, 'utf8');
      const line = (drText.match(/^\s*-?\s*\*\*Findings resolved:\*\*\s*(.*)$/m) || [])[1] || '';
      const ids = Array.from(line.matchAll(/FIND-[A-Za-z0-9_-]+/g)).map((m) => m[0]);
      if (ids.length === 0) continue;
      const { frontmatter: fm } = readFm(dr);
      const taskId = fm && fm.id;
      for (const id of ids) {
        const e = byId.get(id);
        if (e && (e.fields.status || '').trim() === 'open') {
          findingsReconciliation.push({ find_id: id, resolved_by_task: taskId, source_done_report: dr });
        }
      }
    }
  }

  // 6. Review-queue gather.
  const queue = rq.gather(paths.reviewQueuePath(cwd));
  const actionRequiredGrouped = rq.groupByAction(queue.action_required);
  // Map group.severity correctly (groupByAction starts from 'low' — use true max).
  for (const g of actionRequiredGrouped) {
    let sev = 'low';
    for (const e of queue.action_required) {
      if (!g.task_ids.includes(e.task) || e.action !== g.action) continue;
      sev = severityMax(sev, e.severity || 'medium');
    }
    g.severity = sev;
  }
  const otherEntries = [...queue.other, ...queue.config_issue, ...queue.action_required_visual, ...queue.overridden];

  // 7. Compound proposal drafts.
  const activeCompoundDir = path.join(paths.activeDir(cwd), 'compound');
  const compoundDrafts = [];
  const draftCandidates = [];
  if (fs.existsSync(activeCompoundDir)) {
    for (const f of fs.readdirSync(activeCompoundDir)) {
      if (f.endsWith('-proposal.md')) draftCandidates.push(path.join(activeCompoundDir, f));
    }
  }
  const legacySingle = path.join(paths.activeDir(cwd), 'COMPOUND-PROPOSAL.md');
  if (fs.existsSync(legacySingle)) draftCandidates.push(legacySingle);

  const archiveCompoundDir = path.join(paths.archiveDir(cwd), 'compound');
  for (const src of draftCandidates) {
    const { frontmatter: fm } = readFm(src);
    const sprintField = fm && fm.sprint ? fm.sprint : null;
    let sprintsField = null;
    if (fm && Array.isArray(fm.sprints)) sprintsField = fm.sprints.slice();
    else if (sprintField) sprintsField = [sprintField];

    let destPath = null;
    if (sprintsField && sprintsField.length) {
      const nums = sprintsField.map((id) => {
        const m = String(id).match(/^SPRINT-(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      }).filter((n) => n != null);
      if (nums.length) {
        const lo = Math.min(...nums), hi = Math.max(...nums);
        const pad3 = (n) => String(n).padStart(3, '0');
        destPath = path.join(archiveCompoundDir, lo === hi ? `SPRINT-${pad3(lo)}-proposal.md` : `SPRINT-${pad3(lo)}-${pad3(hi)}-proposal.md`);
      }
    }
    compoundDrafts.push({
      source_path: src,
      sprint_field: sprintField,
      sprints_field: sprintsField,
      destination_path: destPath,
      destination_exists: destPath ? fs.existsSync(destPath) : false,
    });
  }

  // 8. Merge strategy.
  const mergeStrategy = config.resolve('git.merge_strategy', '--no-ff', cwd);

  // Emit.
  const payload = {
    sprint: { id: sprintId, status: state.sprint.status, started: state.sprint.started },
    run: state.sprint && state.sprint.run ? state.sprint.run : (state.run || null),
    stats: {
      completed_count: completedTasks.length,
      stuck_count: stuckTasks.length,
      human_needed_count: humanNeeded.length,
      blocked_count: blocked.length,
      total_executor_loops: totalExecutorLoops,
      total_code_review_rounds: totalCodeReviewRounds,
      visual_coverage: {
        per_task: perTaskVisual,
        sprint_level: { ...sprintLevelVisual, regressions_count: regressionsCount },
      },
    },
    completed_tasks: completedTasks,
    stuck_tasks: stuckTasks,
    human_needed_tasks: humanNeeded,
    blocked_tasks: blocked,
    review_queue: {
      action_required: actionRequiredGrouped,
      other_count: otherEntries.length,
      other_summaries: otherEntries.slice(0, 10).map((e) => (e.finding || e.action || e.task || '').toString().slice(0, 120)),
    },
    sprint_code_review: sprintCodeReview,
    findings_reconciliation: findingsReconciliation,
    compound_drafts: compoundDrafts,
    merge_strategy: mergeStrategy,
  };

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main();
