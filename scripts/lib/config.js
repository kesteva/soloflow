'use strict';

// 3-tier config resolution: .soloflow/config.json → $CLAUDE_PLUGIN_ROOT/config/defaults.yaml → inline fallback.

const fs = require('fs');
const path = require('path');
const yaml = require('./yaml');

function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  // Fallback: walk up from this file until we find config/defaults.yaml.
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'config', 'defaults.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function loadLocal(cwd = process.cwd()) {
  const p = path.join(cwd, '.soloflow', 'config.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`.soloflow/config.json is not valid JSON: ${e.message}`); }
}

function loadDefaults() {
  const root = pluginRoot();
  if (!root) return null;
  const p = path.join(root, 'config', 'defaults.yaml');
  if (!fs.existsSync(p)) return null;
  return yaml.parse(fs.readFileSync(p, 'utf8'));
}

function getDeep(obj, dottedKey) {
  if (obj == null) return undefined;
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolve(key, fallback, cwd = process.cwd()) {
  const local = loadLocal(cwd);
  const localVal = getDeep(local, key);
  if (localVal !== undefined && localVal !== null) return localVal;
  const defaults = loadDefaults();
  const defaultVal = getDeep(defaults, key);
  if (defaultVal !== undefined && defaultVal !== null) return defaultVal;
  return fallback;
}

// Merge strategy: deep for plain objects, replace for arrays + scalars.
function deepMerge(base, over) {
  if (over == null) return base;
  if (base == null) return over;
  if (typeof base !== 'object' || typeof over !== 'object' || Array.isArray(base) || Array.isArray(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function resolveAll(cwd = process.cwd()) {
  return deepMerge(loadDefaults() || {}, loadLocal(cwd) || {});
}

module.exports = { pluginRoot, loadLocal, loadDefaults, resolve, resolveAll, getDeep };
