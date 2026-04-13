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

    // Extract agent info from event
    const agentName = event.agent_name || event.teammate_name || '';
    const agentOutput = event.agent_output || event.result || '';

    let context = '';

    // Identify which soloflow agent completed
    if (agentName.includes('executor')) {
      context = `Executor subagent completed. Review the executor's status report and proceed with verification if status is COMPLETED.`;
    } else if (agentName.includes('verifier')) {
      context = `Verifier subagent completed. Review the verification report and handle the verdict (APPROVED/NEEDS_CHANGES/HUMAN_NEEDED).`;
    } else if (agentName.includes('code-reviewer')) {
      context = `Code reviewer completed. Review the code review report and handle the verdict (CLEAN/IMPROVEMENTS_NEEDED/SECURITY_ISSUE).`;
    } else if (agentName.includes('researcher')) {
      context = `Researcher completed. Write the research report and proceed to task refinement.`;
    } else if (agentName.includes('idea-extractor')) {
      context = `Idea extractor completed. Write the idea file and present it to the user for review.`;
    } else if (agentName.includes('task-refiner')) {
      context = `Task refiner completed. Write the plan files and present them to the user for review.`;
    } else if (agentName.includes('compounder')) {
      context = `Compounder completed. Solution files have been written to the archive.`;
    }

    // Detect CONTEXT_LIMIT status and augment context hint
    if (agentOutput && agentOutput.includes('CONTEXT_LIMIT')) {
      context += ' Agent reported CONTEXT_LIMIT — read the handoff section from its status report and spawn a follow-up agent to continue the work.';
    }

    if (context) {
      // Note: we intentionally do not mutate sprint.json here. A cosmetic
      // last_activity timestamp would churn state on every subagent stop and
      // either leak uncommitted state or force a noisy commit from a hook
      // running inside executor worktrees. The orchestrator owns state
      // commits; this hook is injection-only.

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
