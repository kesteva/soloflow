'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('../refiner/sanitize-plan');

const cleanPlan = `---
id: TASK-180
idea: IDEA-042
status: approved
files_owned:
  - src/foo.ts
---

# Add foo

## Implementation Steps

1. Edit src/foo.ts to add bar.

## Lowest Confidence Area

Mocking strategy.
`;

test('sanitize: clean plan returns unchanged body, zero stripped', () => {
  const r = sanitize(cleanPlan, 'TASK-180');
  assert.equal(r.frontmatter_found, true);
  assert.equal(r.id_matches_expected, true);
  assert.equal(r.stripped_bytes, 0);
  assert.equal(r.body.trimEnd(), cleanPlan.trimEnd());
});

test('sanitize: strips trailing agentId line', () => {
  const polluted = cleanPlan + '\nagentId: task-refiner-abc123\n';
  const r = sanitize(polluted, 'TASK-180');
  assert.equal(r.frontmatter_found, true);
  assert.ok(r.stripped_bytes > 0, 'expected non-zero stripped_bytes');
  assert.ok(!r.body.includes('agentId'), 'body should not contain agentId');
  assert.ok(r.body.includes('Mocking strategy.'), 'body should still contain final section');
});

test('sanitize: strips <usage> XML telemetry block', () => {
  const polluted = cleanPlan + '\n<usage>\n  <input_tokens>10000</input_tokens>\n  <output_tokens>500</output_tokens>\n</usage>\n';
  const r = sanitize(polluted, 'TASK-180');
  assert.ok(r.stripped_bytes > 0);
  assert.ok(!r.body.includes('<usage>'));
  assert.ok(!r.body.includes('input_tokens'));
});

test('sanitize: peels outer ```markdown wrapper and post-wrap debug', () => {
  const wrapped = '```markdown\n' + cleanPlan + '```\nagentId: foo\nI considered three approaches before...\n';
  const r = sanitize(wrapped, 'TASK-180');
  assert.equal(r.frontmatter_found, true);
  assert.ok(!r.body.includes('```markdown'));
  assert.ok(!r.body.includes('agentId'));
  assert.ok(!r.body.includes('I considered'));
  assert.ok(r.stripped_bytes > 0);
});

test('sanitize: id_matches_expected false when frontmatter id differs', () => {
  const r = sanitize(cleanPlan, 'TASK-999');
  assert.equal(r.frontmatter_found, true);
  assert.equal(r.id_matches_expected, false);
});

test('sanitize: id_matches_expected null when no expected id given', () => {
  const r = sanitize(cleanPlan, null);
  assert.equal(r.id_matches_expected, null);
});

test('sanitize: no frontmatter returns frontmatter_found=false but still emits body', () => {
  const r = sanitize('just some text\n', 'TASK-001');
  assert.equal(r.frontmatter_found, false);
});

test('sanitize: handles CRLF line endings', () => {
  const crlf = cleanPlan.replace(/\n/g, '\r\n') + '\r\nagentId: x\r\n';
  const r = sanitize(crlf, 'TASK-180');
  assert.equal(r.frontmatter_found, true);
  assert.ok(!r.body.includes('agentId'));
  assert.ok(!r.body.includes('\r'));
});
