---
description: Start the full SoloFlow pipeline from idea through execution and verification
argument-hint: <idea or feature description>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent]
---

# /soloflow-start

You are running the full SoloFlow pipeline. This takes a raw idea through 5 phases: idea extraction → task refinement → execution sprint → human review → compound learning.

The user's idea is: **$ARGUMENTS**

---

## Step 1: Initialize

1. Check if `.soloflow/` directory exists. If not, run the init script to create it.
2. Read `.soloflow/counters.json` for current counters.
3. Read `.soloflow/checkpoint.md` — if it indicates an active sprint mid-execution, ask the user: "A previous sprint is in progress. Resume it or start fresh?"
   - If resume: skip to the phase indicated in the checkpoint
   - If fresh: continue below

## Step 2: Phase 1 — Idea Extraction

1. Generate the next idea ID: `IDEA-{padded counters.ideas + 1}` (zero-padded to 3 digits).
2. Spawn the **soloflow-idea-extractor** agent via the Agent tool with:
   - The user's raw input
   - The idea ID to use
   - Instruction: "Extract and structure this idea. Use the provided idea ID. Output the complete IDEA file content."
3. Capture the extractor's output.
4. Write the idea file to `.soloflow/active/ideas/IDEA-{NNN}.md`.
5. Update `.soloflow/counters.json`: increment `ideas`.

**BUGFIX routing:** If the extractor classified the idea as BUGFIX, tell the user: "This looks like a bug. Routing to `/soloflow-quick` for faster resolution." Then follow the `/soloflow-quick` flow instead. Stop the pipeline here.

## Step 3: Human Checkpoint 1 — Idea Review

Present the idea to the user with a clear summary:
- Type and classification
- Slices (with value statements)
- Open questions that need answers
- Assumptions that need validation

Ask the user:
- **Approve + Research** — run external research, then proceed to refinement (default when `phases.research: true` in config)
- **Approve (skip research)** — proceed directly to refinement
- **Modify** — update slices, answer questions, add constraints
- **Reject** — stop the pipeline

**PAUSE HERE. Do not proceed until the user responds.**

If the user modifies the idea, update the idea file accordingly. If the user answers open questions, incorporate the answers.

## Step 3.5: Phase 1.5 — Research (if selected)

If the user chose "Approve + Research":

1. Spawn the **soloflow-researcher** agent via the Agent tool with:
   - The approved idea file content
   - Instruction: "Research this idea. For each slice, search for existing libraries, best practices, API docs, and prior art. For each open question, attempt to find an external answer. For each low/medium-confidence assumption, search for evidence. Output a structured research report."
2. Capture the researcher's output.
3. Write the research report to `.soloflow/active/research/IDEA-{NNN}-research.md`.

If the user chose "Approve (skip research)", skip this step entirely.

## Step 4: Phase 2 — Task Refinement

1. Read the approved idea file.
2. Read `.soloflow/counters.json` for the starting task counter: `tasks + 1`.
3. Spawn the **soloflow-task-refiner** agent via the Agent tool with:
   - The approved idea file content
   - If a research report exists at `.soloflow/active/research/IDEA-{NNN}-research.md`, include it with the instruction: "A research report is provided below. Use it to inform your approach selection, library choices, and to resolve open questions before doing your own research."
   - The starting task counter
   - Instruction: "Refine this idea into execution-ready plans. Start task numbering at TASK-{NNN}. Output each plan file's content clearly separated."
4. Capture the refiner's output.
5. Parse the output into individual plan files.
6. Write each plan to `.soloflow/active/plans/TASK-{NNN}-plan.md`.
7. Update `.soloflow/counters.json`: increment `tasks` by the number of plans.
8. Add each task to `.soloflow/active/backlog.json` with `status: "ready"` and its `depends_on` list.

## Step 5: Human Checkpoint 2 — Plan Review

Present all plans to the user with:
- Task count and dependency graph
- Total estimated complexity
- Decisions made and tradeoffs resolved
- Open questions requiring human input (if any were escalated)
- Any requirements that were dropped with reasoning

Ask the user:
- **Approve all** — proceed to execution
- **Approve subset** — mark unapproved plans as `status: "deferred"` in progress.json
- **Request changes** — re-run refinement with user's feedback on specific plans
- **Reject** — stop the pipeline

**PAUSE HERE. Do not proceed until the user responds.**

## Step 6: Phase 3 — Execution Sprint

Follow the orchestration algorithm from `agents/soloflow-orchestrator.md`:

1. **Create sprint** in `.soloflow/active/sprint.json`:
   - Read `.soloflow/counters.json` for sprint counter
   - Generate sprint ID: `SPRINT-{padded sprints + 1}`
   - Set `sprint.status: "active"`, `sprint.started: {ISO timestamp}`
   - Increment `sprints` in `.soloflow/counters.json`
   - Move approved tasks from `.soloflow/active/backlog.json` to `sprint.json`

2. **Build dependency graph** from approved plans' `depends_on` fields. Tasks with no dependencies are immediately ready.

3. **Execute the loop:**

   For each ready task (dependencies all completed):
   
   a. Set task `status: "in_progress"` in `.soloflow/active/sprint.json`
   
   b. Spawn **soloflow-executor** with the plan content. Wait for result.
   
   c. Handle executor result:
      - **COMPLETED** → proceed to verification
      - **BLOCKED** → update status to `"blocked"` in sprint.json, continue to next task
      - **STUCK** → write stuck report to `.soloflow/active/stuck/TASK-{NNN}-stuck.md`, update status in sprint.json, continue
   
   d. Spawn **soloflow-verifier** with plan + executor report. Wait for verdict.
   
   e. Handle verifier verdict:
      - **APPROVED** → proceed to code review (Step 6.4)
      - **NEEDS_CHANGES** → if loops < 3 (from config `executor_retry_max`), re-spawn executor with verifier feedback. Otherwise write stuck report.
      - **HUMAN_NEEDED** → add to `.soloflow/human-review-queue.md`, update status in sprint.json

   f. Every 3 completed tasks (from config `checkpoint_interval`): write checkpoint to `.soloflow/checkpoint.md`

4. **Code review** (after verifier APPROVED):

   Spawn **soloflow-code-reviewer** with the plan + executor's changed files list. Wait for verdict.
   
   - **CLEAN** → write done report to `.soloflow/archive/done/TASK-{NNN}-done.md`, remove from sprint.json
   - **IMPROVEMENTS_NEEDED** (first time only) → re-spawn executor with review feedback, then re-verify. This does NOT consume the executor retry budget — code review gets 1 separate retry.
   - **SECURITY_ISSUE** → escalate to HUMAN_NEEDED regardless. Add to `.soloflow/human-review-queue.md`, update status in sprint.json.

5. **Complete sprint** — set `sprint.status: "complete"` in `.soloflow/active/sprint.json`.

## Step 7: Phase 4 — Human Review

Read `.soloflow/human-review-queue.md` and all stuck reports from `.soloflow/active/stuck/`.

Present a consolidated review:
- **Completed tasks** with brief summaries
- **Tasks needing human judgment** (from HUMAN_NEEDED verdicts) with the verifier's notes
- **Stuck tasks** with failure details and what was tried
- **Sprint statistics:** tasks completed, stuck, human-needed, total executor loops

**PAUSE HERE.** The user's job is taste-level review — does this feel right? Everything functional has already been verified.

## Step 8: Phase 5 — Compound Learning

1. Read `.soloflow/counters.json` for starting solution counter: `solutions + 1`.
2. Spawn the **soloflow-compounder** agent with:
   - References to all done reports and stuck reports from this sprint
   - The starting solution counter
   - Instruction: "Extract reusable patterns from this sprint. Write SOL files to `.soloflow/archive/solutions/`."
3. The compounder writes solution files directly.
4. Update `.soloflow/counters.json`: increment `solutions` by the number of solutions produced.

## Step 9: Final Summary

```
## SoloFlow Pipeline — Complete
- **Idea:** IDEA-{NNN} ({title})
- **Sprint:** SPRINT-{NNN}
- **Tasks completed:** {count}
- **Tasks stuck:** {count}
- **Tasks human-needed:** {count}
- **Solutions captured:** {count}
- **Total executor loops:** {count}
```

---

## Important Notes

- This command IS the orchestrator. It runs in the main session and spawns all agents as leaf-node subagents.
- Human checkpoints are mandatory pauses. Do not auto-proceed past them.
- If the user's description is too vague, ask for clarification BEFORE Phase 1.
- If the idea turns out to be a simple bugfix, route to `/soloflow-quick` — the full pipeline is overkill for bugs.
- The executor uses Sonnet for cost efficiency. The verifier and task-refiner use Opus for thorough analysis.
