---
description: Extract a structured idea from raw input, with optional external research
argument-hint: <idea or feature description>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:idea-extractor

Phase 1 of the SoloFlow pipeline. Turns raw input into a structured idea file, and optionally runs external research on it.

The user's idea is: **$ARGUMENTS**

---

## Step 1: Initialize

1. If `.soloflow/` does not exist, run `scripts/init.sh` to create it.
2. Read `.soloflow/counters.json` for current counters.

## Step 2: Extract the Idea

1. Generate the next idea ID: `IDEA-{padded counters.ideas + 1}` (zero-padded to 3 digits).
2. Spawn the **idea-extractor** agent via the Agent tool with:
   - The user's raw input
   - The idea ID to use
   - Instruction: "Extract and structure this idea. Use the provided idea ID. Output the complete IDEA file content."
3. Capture the extractor's output.
4. Write the idea file to `.soloflow/active/ideas/IDEA-{NNN}.md`.
5. Update `.soloflow/counters.json`: increment `ideas`.

**BUGFIX routing:** If the extractor classified the idea as BUGFIX, tell the user: "This looks like a bug. Consider `/soloflow:quick` for faster resolution." Then stop — do not proceed to research.

## Step 3: Human Checkpoint — Idea Review

Present the idea to the user with:
- Type and classification
- Slices (with value statements)
- Open questions that need answers
- Assumptions that need validation

Use the **AskUserQuestion** tool to present the choice. Do not list the options as plain markdown bullets — the user should see a structured picker. Ask a single question like "How should we proceed with this idea?" with these options:
- **Approve + Research** — run external research next (default when `phases.research: true` in config)
- **Approve (skip research)** — stop here; idea is ready for `/soloflow:planner`
- **Modify** — update slices, answer questions, add constraints
- **Reject** — delete the idea file and stop

The tool call blocks until the user responds — do not proceed until it returns.

If the user modifies the idea, update the idea file accordingly before continuing.

## Step 4: Research (if selected)

If the user chose "Approve + Research":

1. Spawn the **researcher** agent via the Agent tool with:
   - The approved idea file content
   - Instruction: "Research this idea. For each slice, search for existing libraries, best practices, API docs, and prior art. For each open question, attempt to find an external answer. For each low/medium-confidence assumption, search for evidence. Output a structured research report."
2. Capture the researcher's output.
3. Write the research report to `.soloflow/active/research/IDEA-{NNN}-research.md`.

## Step 5: Report

Tell the user:
```
Idea extracted: IDEA-{NNN} ({title})
{Research report: IDEA-{NNN}-research.md  — if applicable}

Next step: /soloflow:planner IDEA-{NNN}
```

---

## Notes

- This command does NOT refine into tasks — that's `/soloflow:planner`.
- If the user's description is too vague, ask for clarification BEFORE spawning the extractor. Prefer the **AskUserQuestion** tool when the clarification can be framed as a choice; use a free-form text question only when the clarification is genuinely open-ended.
