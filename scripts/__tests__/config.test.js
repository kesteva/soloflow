'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mktmp, scaffold, run } = require('./helpers');

test('config: falls back through local → defaults → inline', () => {
  const cwd = scaffold(mktmp());
  // No local config — should get the defaults.yaml value.
  const r1 = run('config/resolve.js', ['--key', 'models.executor', '--fallback', 'INLINE'], { cwd });
  assert.equal(r1.ok, true);
  assert.equal(r1.out, 'sonnet');

  // Unknown key — should get the inline fallback.
  const r2 = run('config/resolve.js', ['--key', 'nope.missing', '--fallback', 'INLINE'], { cwd });
  assert.equal(r2.ok, true);
  assert.equal(r2.out, 'INLINE');

  // With a local override.
  fs.writeFileSync(path.join(cwd, '.soloflow/config.json'), JSON.stringify({ models: { executor: 'haiku' } }));
  const r3 = run('config/resolve.js', ['--key', 'models.executor'], { cwd });
  assert.equal(r3.out, 'haiku');
});

test('config: --all returns merged object', () => {
  const cwd = scaffold(mktmp());
  fs.writeFileSync(path.join(cwd, '.soloflow/config.json'), JSON.stringify({ limits: { max_sprint_tasks: 42 } }));
  const r = run('config/resolve.js', ['--all'], { cwd });
  assert.equal(r.ok, true);
  const data = JSON.parse(r.out);
  assert.equal(data.limits.max_sprint_tasks, 42);
  assert.equal(data.limits.executor_retry_max, 3); // inherited from defaults.yaml
});
