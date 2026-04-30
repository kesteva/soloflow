'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run, writePlan } = require('./helpers');

test('cruft-detect: orphan plan + mid-commit settle + empty epic', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: {
    // Mid-commit crash: done report exists AND task still in sprint.json.
    'TASK-010': { status: 'in_progress' },
  } });
  // Orphan plan: plan in active + done report in archive.
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/auth/TASK-005-plan.md'), '');
  fs.mkdirSync(path.join(cwd, '.soloflow/archive/done/auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/auth/TASK-005-done.md'), '');
  // Mid-commit: done for TASK-010.
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/TASK-010-done.md'), '');
  // Empty epic.
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/ghost-epic'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/ghost-epic/EPIC-ghost-epic.md'), '');

  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.orphan_plan.length, 1);
  assert.equal(r.orphan_plan[0].task_id, 'TASK-005');
  assert.equal(r.mid_commit_settle.length, 1);
  assert.equal(r.mid_commit_settle[0].task_id, 'TASK-010');
  assert.equal(r.empty_epic.length, 1);
  assert.equal(r.empty_epic[0].epic_slug, 'ghost-epic');
});

test('cruft-detect: untracked_plan — plan on disk with no status frontmatter', () => {
  const cwd = scaffold(mktmp());
  // Plan on disk, frontmatter has epic + title but no status.
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/auth'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/plans/auth/TASK-040-plan.md'),
    '---\ntitle: Wire login flow\nepic: auth\n---\n\nbody\n',
  );

  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.untracked_plan.length, 1);
  assert.equal(r.untracked_plan[0].task_id, 'TASK-040');
  assert.equal(r.untracked_plan[0].status, null);
  assert.equal(r.untracked_plan[0].epic, 'auth');
  assert.equal(r.untracked_plan[0].title, 'Wire login flow');
  assert.match(r.untracked_plan[0].plan_path, /TASK-040-plan\.md$/);
  assert.equal(r.total, 1);
});

test('cruft-detect: untracked_plan empty when plan has status: ready', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-041', { status: 'ready', title: 'queued' }, { epic: 'auth' });
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.untracked_plan.length, 0);
  assert.equal(r.total, 0);
});

test('cruft-detect: untracked_plan empty when plan has status: in-flight', () => {
  const cwd = scaffold(mktmp(), { withSprint: true, sprintTasks: { 'TASK-042': { status: 'in_progress' } } });
  writePlan(cwd, 'TASK-042', { status: 'in-flight', title: 'live' }, { epic: 'auth' });
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.untracked_plan.length, 0);
});

test('cruft-detect: untracked_plan flags unrecognized status values', () => {
  const cwd = scaffold(mktmp());
  writePlan(cwd, 'TASK-050', { status: 'in_progress' }); // hyphen vs underscore — invalid
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.untracked_plan.length, 1);
  assert.equal(r.untracked_plan[0].task_id, 'TASK-050');
  assert.equal(r.untracked_plan[0].status, 'in_progress');
});

test('cruft-detect: untracked_plan defers to orphan_plan when done report exists', () => {
  const cwd = scaffold(mktmp());
  fs.mkdirSync(path.join(cwd, '.soloflow/active/plans/auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/active/plans/auth/TASK-043-plan.md'), '---\ntitle: t\nepic: auth\n---\n');
  fs.mkdirSync(path.join(cwd, '.soloflow/archive/done/auth'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.soloflow/archive/done/auth/TASK-043-done.md'), '');

  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.untracked_plan.length, 0);
  assert.equal(r.orphan_plan.length, 1);
  assert.equal(r.orphan_plan[0].task_id, 'TASK-043');
});

test('cruft-detect: completed_in_backlog field is removed from output', () => {
  const cwd = scaffold(mktmp());
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal('completed_in_backlog' in r, false);
});

test('cruft-detect: stale_idea — IDEA older than threshold is flagged', () => {
  const cwd = scaffold(mktmp());
  const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/ideas/IDEA-001.md'),
    `---\nid: IDEA-001\ncreated: ${oldDate}\nstatus: deferred\n---\n\n# old idea\n`,
  );
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.stale_idea.length, 1);
  assert.equal(r.stale_idea[0].idea_id, 'IDEA-001');
  assert.ok(r.stale_idea[0].age_days >= 100);
});

test('cruft-detect: stale_idea — fresh IDEA is not flagged', () => {
  const cwd = scaffold(mktmp());
  const recent = new Date().toISOString();
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/ideas/IDEA-002.md'),
    `---\nid: IDEA-002\ncreated: ${recent}\nstatus: deferred\n---\n\n# new idea\n`,
  );
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.stale_idea.length, 0);
});

test('cruft-detect: stale_idea — IDEA without created frontmatter is skipped (migrate-004 backfills)', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(
    path.join(cwd, '.soloflow/active/ideas/IDEA-003.md'),
    '---\nid: IDEA-003\nstatus: deferred\n---\n\n# unstamped idea\n',
  );
  const r = JSON.parse(run('state/cruft-detect.js', [], { cwd }).out);
  assert.equal(r.stale_idea.length, 0);
});
