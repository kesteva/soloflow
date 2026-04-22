'use strict';

const path = require('path');

function stateRoot(cwd = process.cwd()) { return path.join(cwd, '.soloflow'); }
function activeDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'active'); }
function archiveDir(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'archive'); }

function sprintJsonPath(cwd = process.cwd()) { return path.join(activeDir(cwd), 'sprint.json'); }
function backlogJsonPath(cwd = process.cwd()) { return path.join(activeDir(cwd), 'backlog.json'); }
function checkpointPath(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'checkpoint.md'); }
function reviewQueuePath(cwd = process.cwd()) { return path.join(stateRoot(cwd), 'human-review-queue.md'); }

function findingsFilePath(sprintId, cwd = process.cwd()) {
  return path.join(activeDir(cwd), 'findings', `${sprintId}-findings.md`);
}

module.exports = {
  stateRoot, activeDir, archiveDir,
  sprintJsonPath, backlogJsonPath, checkpointPath, reviewQueuePath,
  findingsFilePath,
};
