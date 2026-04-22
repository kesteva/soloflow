'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('../lib/yaml');

test('yaml: parses nested maps and lists', () => {
  const doc = yaml.parse(`
models:
  verifier: opus
  executor: sonnet
limits:
  max: 10
tags:
  - a
  - b
`);
  assert.equal(doc.models.verifier, 'opus');
  assert.equal(doc.models.executor, 'sonnet');
  assert.equal(doc.limits.max, 10);
  assert.deepEqual(doc.tags, ['a', 'b']);
});

test('yaml: parses compact block-sequence', () => {
  const doc = yaml.parse(`
key:
- item1
- item2
`);
  assert.deepEqual(doc.key, ['item1', 'item2']);
});

test('yaml: parses scalars with quotes and comments', () => {
  const doc = yaml.parse(`
# leading comment
branch: "soloflow/run-{timestamp}"  # trailing comment
merge: --no-ff
count: 3
flag: true
missing: null
`);
  assert.equal(doc.branch, 'soloflow/run-{timestamp}');
  assert.equal(doc.merge, '--no-ff');
  assert.equal(doc.count, 3);
  assert.equal(doc.flag, true);
  assert.equal(doc.missing, null);
});

test('yaml: frontmatter split + rejoin preserves body', () => {
  const input = `---
sprint: SPRINT-001
pending_count: 3
---

# Findings

## FIND-SPRINT-001-1
- **status:** open
`;
  const { frontmatter, body } = yaml.splitFrontmatter(input);
  assert.equal(frontmatter.sprint, 'SPRINT-001');
  assert.equal(frontmatter.pending_count, 3);
  assert.match(body, /# Findings/);
  const rejoined = yaml.joinFrontmatter(frontmatter, body);
  // Rejoin must be parseable back to the same frontmatter.
  const reparsed = yaml.splitFrontmatter(rejoined);
  assert.equal(reparsed.frontmatter.sprint, 'SPRINT-001');
  assert.equal(reparsed.frontmatter.pending_count, 3);
});
