'use strict';

const fs = require('fs');

function writeAtomic(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function writeExclusive(filePath, content) {
  // Write only if the file does not already exist. Returns true if written.
  try {
    fs.writeFileSync(filePath, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

module.exports = { writeAtomic, writeExclusive };
