'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyCorrections } = require('../refiner/apply-parity');
const yaml = require('../lib/yaml');

function tmpPlan(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-parity-'));
  const p = path.join(dir, 'plan.md');
  fs.writeFileSync(p, content);
  return p;
}

test('apply-parity: no corrections leaves file byte-identical', () => {
  const plan = `---
id: TASK-100
files_owned:
  - src/foo.ts
files_readonly:
  - src/bar.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  const result = applyCorrections(p, { move_to_owned: [], insert_to_owned: [], test_targets_missing: [] });
  assert.equal(result.corrections.length, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), plan);
});

test('apply-parity: test_targets_missing appended to files_owned', () => {
  const plan = `---
id: TASK-101
files_owned:
  - src/foo.ts
test_strategy:
  needed: true
  targets:
    - behavior: test foo
      test_file: __tests__/foo.test.ts
      type: unit
---

# Plan
`;
  const p = tmpPlan(plan);
  const result = applyCorrections(p, {
    move_to_owned: [],
    insert_to_owned: [],
    test_targets_missing: ['__tests__/foo.test.ts'],
  });
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].action, 'test_target_added');
  assert.equal(result.corrections[0].path, '__tests__/foo.test.ts');

  const fm = yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter;
  assert.ok(fm.files_owned.includes('__tests__/foo.test.ts'));
});

test('apply-parity: move_to_owned moves path from readonly to owned', () => {
  const plan = `---
id: TASK-103
files_owned:
  - src/foo.ts
files_readonly:
  - src/bar.ts
  - src/keep.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  const result = applyCorrections(p, {
    move_to_owned: ['src/bar.ts'],
    insert_to_owned: [],
    test_targets_missing: [],
  });
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].action, 'readonly_to_owned');

  const fm = yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter;
  assert.ok(fm.files_owned.includes('src/bar.ts'));
  assert.ok(!fm.files_readonly.includes('src/bar.ts'));
  assert.ok(fm.files_readonly.includes('src/keep.ts'));
});

test('apply-parity: insert_to_owned appends to files_owned', () => {
  const plan = `---
id: TASK-104
files_owned:
  - src/foo.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  const result = applyCorrections(p, {
    move_to_owned: [],
    insert_to_owned: ['src/missing.ts'],
    test_targets_missing: [],
  });
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].action, 'inserted');

  const fm = yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter;
  assert.ok(fm.files_owned.includes('src/missing.ts'));
});

test('apply-parity: deduplicates path already in files_owned (no-op)', () => {
  const plan = `---
id: TASK-105
files_owned:
  - src/foo.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  const result = applyCorrections(p, {
    move_to_owned: [],
    insert_to_owned: [],
    test_targets_missing: ['src/foo.ts'],
  });
  assert.equal(result.corrections.length, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), plan);
});

test('apply-parity: idempotent on second run', () => {
  const plan = `---
id: TASK-106
files_owned:
  - src/foo.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  applyCorrections(p, {
    move_to_owned: [],
    insert_to_owned: [],
    test_targets_missing: ['__tests__/foo.test.ts'],
  });
  const afterFirst = fs.readFileSync(p, 'utf8');

  // Second run with the same report (now stale — path already owned).
  const result = applyCorrections(p, {
    move_to_owned: [],
    insert_to_owned: [],
    test_targets_missing: ['__tests__/foo.test.ts'],
  });
  assert.equal(result.corrections.length, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), afterFirst);
});

test('apply-parity: combines all three correction kinds in one pass', () => {
  const plan = `---
id: TASK-107
files_owned:
  - src/foo.ts
files_readonly:
  - src/bar.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  const result = applyCorrections(p, {
    move_to_owned: ['src/bar.ts'],
    insert_to_owned: ['src/baz.ts'],
    test_targets_missing: ['__tests__/foo.test.ts'],
  });
  assert.equal(result.corrections.length, 3);

  const actions = result.corrections.map((c) => c.action).sort();
  assert.deepEqual(actions, ['inserted', 'readonly_to_owned', 'test_target_added']);

  const fm = yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter;
  assert.ok(fm.files_owned.includes('src/bar.ts'));
  assert.ok(fm.files_owned.includes('src/baz.ts'));
  assert.ok(fm.files_owned.includes('__tests__/foo.test.ts'));
  assert.ok(!fm.files_readonly.includes('src/bar.ts'));
});

test('apply-parity: missing files_readonly stays absent when nothing to move', () => {
  const plan = `---
id: TASK-108
files_owned:
  - src/foo.ts
---

# Plan
`;
  const p = tmpPlan(plan);
  applyCorrections(p, {
    move_to_owned: [],
    insert_to_owned: ['src/added.ts'],
    test_targets_missing: [],
  });
  const fm = yaml.splitFrontmatter(fs.readFileSync(p, 'utf8')).frontmatter;
  assert.equal(fm.files_readonly, undefined);
});
