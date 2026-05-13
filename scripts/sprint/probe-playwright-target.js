#!/usr/bin/env node
'use strict';

// Project-type probe for the Playwright-preference verifier path.
//
// Detects whether the project is one of:
//   - electron   — `electron` in deps/devDeps
//   - tauri      — `@tauri-apps/api` (or @tauri-apps/cli) in deps OR `src-tauri/` dir
//   - expo-web   — `expo` in deps AND web platform declared in app.json or app.config.{js,ts,mjs,cjs}
//   - capacitor  — `@capacitor/core` in deps AND capacitor.config.{ts,js,json}
//
// Detection order is deliberate: desktop-binary targets (electron, tauri) win
// over webview/expo because their renderer Playwright drives IS the shipped
// surface, so they carry no divergence risk. Expo / Capacitor carry
// `divergence_risk: true` because Platform.OS=='web' branches and native-only
// modules diverge from the iOS/Android target.
//
// Used by sprint-initiator at sprint start; result is cached in sprint.json
// under `playwright_target` and read by shadow-verifier / shadow-sprint-verifier
// during path selection.
//
// Usage:
//   node probe-playwright-target.js [--cwd <path>]
//
// Output (JSON):
//   {
//     "kind": "electron" | "tauri" | "expo-web" | "capacitor" | null,
//     "evidence": "<short string>",
//     "dev_url_hint": "<url or null>",
//     "divergence_risk": boolean
//   }

const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/args');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return null; }
}

function depsOf(pkg) {
  if (!pkg) return new Set();
  const merged = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
    pkg.peerDependencies || {},
    pkg.optionalDependencies || {}
  );
  return new Set(Object.keys(merged));
}

function detectElectron(cwd, deps) {
  if (!deps.has('electron')) return null;
  return {
    kind: 'electron',
    evidence: 'electron in package.json',
    dev_url_hint: null,
    divergence_risk: false,
  };
}

function detectTauri(cwd, deps) {
  const hasDep = deps.has('@tauri-apps/api') || deps.has('@tauri-apps/cli');
  const hasDir = fs.existsSync(path.join(cwd, 'src-tauri'));
  if (!hasDep && !hasDir) return null;

  let devUrl = null;
  const tauriConf = readJson(path.join(cwd, 'src-tauri', 'tauri.conf.json'));
  if (tauriConf && tauriConf.build) {
    if (typeof tauriConf.build.devUrl === 'string') devUrl = tauriConf.build.devUrl;
    else if (typeof tauriConf.build.devPath === 'string' && /^https?:/.test(tauriConf.build.devPath)) devUrl = tauriConf.build.devPath;
  }

  const ev = hasDir && hasDep
    ? 'src-tauri/ + @tauri-apps in package.json'
    : hasDir ? 'src-tauri/ directory' : '@tauri-apps in package.json';

  return {
    kind: 'tauri',
    evidence: ev,
    dev_url_hint: devUrl,
    divergence_risk: false,
  };
}

function detectExpoWeb(cwd, deps) {
  if (!deps.has('expo')) return null;

  // app.json — either { "expo": { ... } } or top-level expo fields.
  const appJson = readJson(path.join(cwd, 'app.json'));
  if (appJson) {
    const block = appJson.expo || appJson;
    if (block && block.web && typeof block.web === 'object') {
      return {
        kind: 'expo-web',
        evidence: 'expo dep + app.json declares web platform',
        dev_url_hint: 'http://localhost:8081/',
        divergence_risk: true,
      };
    }
    if (block && Array.isArray(block.platforms) && block.platforms.includes('web')) {
      return {
        kind: 'expo-web',
        evidence: 'expo dep + app.json platforms includes web',
        dev_url_hint: 'http://localhost:8081/',
        divergence_risk: true,
      };
    }
  }

  // app.config.{js,ts,mjs,cjs} — text grep since we can't safely evaluate them.
  for (const name of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs']) {
    const text = readText(path.join(cwd, name));
    if (!text) continue;
    if (/web\s*:\s*\{/.test(text) || /platforms\s*:\s*\[[^\]]*['"]web['"]/.test(text)) {
      return {
        kind: 'expo-web',
        evidence: `expo dep + ${name} references web platform`,
        dev_url_hint: 'http://localhost:8081/',
        divergence_risk: true,
      };
    }
  }

  return null;
}

function detectCapacitor(cwd, deps) {
  if (!deps.has('@capacitor/core')) return null;
  for (const name of ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json']) {
    if (fs.existsSync(path.join(cwd, name))) {
      return {
        kind: 'capacitor',
        evidence: `@capacitor/core + ${name}`,
        dev_url_hint: null,
        divergence_risk: true,
      };
    }
  }
  return null;
}

function detect(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'));
  const deps = depsOf(pkg);

  // Order: desktop binaries (no divergence) before webview/expo.
  return (
    detectElectron(cwd, deps) ||
    detectTauri(cwd, deps) ||
    detectExpoWeb(cwd, deps) ||
    detectCapacitor(cwd, deps) ||
    { kind: null, evidence: 'no Playwright-driveable project type detected', dev_url_hint: null, divergence_risk: false }
  );
}

function main() {
  const { opts } = parse(process.argv.slice(2));
  const cwd = typeof opts.cwd === 'string' ? path.resolve(opts.cwd) : process.cwd();
  const result = detect(cwd);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
