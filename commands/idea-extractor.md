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

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 2: Extract the Idea

1. Generate the next idea ID by globbing `.soloflow/active/ideas/IDEA-*.md`, extracting each numeric suffix, and taking `max + 1` (zero-padded to 3 digits). See the "ID allocation" section in the project `CLAUDE.md` for the shared recipe.
2. Spawn the **idea-extractor** agent via the Agent tool with:
   - The user's raw input
   - The idea ID to use
   - Instruction: "Extract and structure this idea. Use the provided idea ID. Output the complete IDEA file content."
3. Capture the extractor's output.
4. Write the idea file to `.soloflow/active/ideas/IDEA-{NNN}.md` using `noclobber` / `wx` semantics. If the target already exists (another parallel worker raced), recompute the next ID and retry.

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

## Step 4.5: Commit state

Commit the newly written state files via Bash. Stage only the specific paths you wrote in this run — never `git add .` / `git add -A`.

1. `git add .soloflow/active/ideas/IDEA-{NNN}.md` (and `.soloflow/active/research/IDEA-{NNN}-research.md` if Step 4 ran).
2. If `git diff --cached --quiet` reports no staged changes, skip (idempotent re-run).
3. Otherwise `git commit -m "chore: capture IDEA-{NNN}"`.

Skip this step silently if the project is not inside a git repo (`git rev-parse --is-inside-work-tree`) or if `.soloflow/` is gitignored.

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
