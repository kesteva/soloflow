'use strict';

// Cooperative file lock via O_EXCL create.
//
// Two parallel writers race to create lockPath; the loser retries with backoff
// until the holder releases (deletes the file) or until maxAttempts elapses.
// Stale locks (process crashed before release) are reclaimed when an attempt
// finds the lock older than staleMs.
//
// Usage:
//   await withFileLock(lockPath, () => { ...critical section... }, {
//     maxAttempts: 50,    // default 50
//     intervalMs: 20,     // default 20
//     staleMs: 30000,     // default 30s — reclaim if file mtime exceeds this
//   });

const fs = require('fs');
const path = require('path');

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function tryAcquire(lockPath) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

function isStale(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch { return false; }
}

async function withFileLock(lockPath, fn, opts = {}) {
  const maxAttempts = opts.maxAttempts || 50;
  const intervalMs = opts.intervalMs || 20;
  const staleMs = opts.staleMs || 30000;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (tryAcquire(lockPath)) {
      try {
        return await fn();
      } finally {
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
      }
    }
    if (isStale(lockPath, staleMs)) {
      try { fs.unlinkSync(lockPath); } catch { /* race with another reclaimer; retry */ }
      continue;
    }
    await sleep(intervalMs);
  }
  throw new Error(`withFileLock: timed out acquiring ${lockPath} after ${maxAttempts} attempts`);
}

module.exports = { withFileLock };
