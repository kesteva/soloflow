#!/usr/bin/env node

// SoloFlow subagent-stop hook — updates progress state when a subagent completes
// NOTE: This hook CANNOT spawn agents. It only updates state files and injects context.

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const soloflowDir = path.join(cwd, '.soloflow');

// Silent exit if SoloFlow not initialized
if (!fs.existsSync(soloflowDir)) {
  process.exit(0);
}

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    const progressPath = path.join(soloflowDir, 'active', 'progress.json');

    if (!fs.existsSync(progressPath)) {
      process.exit(0);
    }

    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    const now = new Date().toISOString();

    // Extract agent info from event
    const agentName = event.agent_name || event.teammate_name || '';
    const agentOutput = event.agent_output || event.result || '';

    let context = '';

    // Identify which soloflow agent completed
    if (agentName.includes('executor') || agentName.includes('soloflow-executor')) {
      context = `Executor subagent completed. Review the executor's status report and proceed with verification if status is COMPLETED.`;
    } else if (agentName.includes('verifier') || agentName.includes('soloflow-verifier')) {
      context = `Verifier subagent completed. Review the verification report and handle the verdict (APPROVED/NEEDS_CHANGES/HUMAN_NEEDED).`;
    } else if (agentName.includes('idea-extractor') || agentName.includes('soloflow-idea-extractor')) {
      context = `Idea extractor completed. Write the idea file and present it to the user for review.`;
    } else if (agentName.includes('task-refiner') || agentName.includes('soloflow-task-refiner')) {
      context = `Task refiner completed. Write the plan files and present them to the user for review.`;
    } else if (agentName.includes('compounder') || agentName.includes('soloflow-compounder')) {
      context = `Compounder completed. Solution files have been written to the archive.`;
    }

    if (context) {
      // Update last activity timestamp
      if (progress.sprint && progress.sprint.status === 'active') {
        progress.sprint.last_activity = now;
        fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      }

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStop',
          additionalContext: context
        }
      }));
    }
  } catch (e) {
    // Don't block on errors
  }

  process.exit(0);
});
