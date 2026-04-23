---
description: Extract a structured idea from raw input, with optional external research
argument-hint: <idea or feature description>
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion]
---

# /soloflow:idea-extractor

Phase 1 of the SoloFlow pipeline. Turns raw input into a structured idea file, and optionally runs external research on it.

The user's idea is: **$ARGUMENTS**

---

## Model resolution (applies to every Agent spawn below)

Before invoking the Agent tool, resolve `models.<name>` per the three-tier
recipe in [docs/CUSTOMIZATION.md#config-resolution](../docs/CUSTOMIZATION.md)
and pass the resolved value as the Agent tool's `model` parameter.

Mapping used in this command:
- `idea-extractor` → `models.idea_extractor` (fallback: `sonnet`)
- `researcher` → `models.researcher` (fallback: `sonnet`)

## Step 1: Initialize

1. If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1.5: Clarify if ambiguous

1. Resolve `clarify_enabled`:
   - If `$ARGUMENTS` contains the literal token `--skip-clarify`, set `clarify_enabled = false` and strip the token from `$ARGUMENTS` before using it downstream.
   - Else if `.soloflow/config.json` exists and contains `phases.clarify === false`, set `clarify_enabled = false`.
   - Else if `config/defaults.yaml` (via `${CLAUDE_PLUGIN_ROOT}`) has `phases.clarify: false`, set `clarify_enabled = false`.
   - Otherwise `clarify_enabled = true`.

2. If `clarify_enabled` is false, set `brief = $ARGUMENTS` and proceed to Step 2.

3. Read `${CLAUDE_PLUGIN_ROOT}/skills/clarify-idea/SKILL.md` via the `Read` tool and apply its **"When to invoke"** checklist against `$ARGUMENTS`. The checklist covers: goal, target user/surface, success signal, scope boundary, grounding.

4. If every checklist item is satisfied, the input is already clear — set `brief = $ARGUMENTS` and proceed to Step 2 without running the loop.

5. Otherwise, run the clarification routine defined in the skill:
   - Honor the scope-decomposition gate first (if the ask spans multiple independent subsystems, pick one via `AskUserQuestion`).
   - Run the clarification loop: one `AskUserQuestion` at a time, preferring multi-choice, following threads, until the checklist is satisfied.
   - Present the skill's hard-gated readiness prompt ("Ready to extract the idea?" — Extract now / Keep clarifying / Cancel). Loop on "Keep clarifying." Stop the whole command on "Cancel."
   - On "Extract now," assemble the **clarified brief** (raw input + transcript + synthesis paragraph) exactly as the skill specifies, and set `brief` to that markdown block.

## Step 2: Extract the Idea

1. Generate the next idea ID by globbing `.soloflow/active/ideas/IDEA-*.md`, extracting each numeric suffix, and taking `max + 1` (zero-padded to 3 digits). See the "ID allocation" section in the project `CLAUDE.md` for the shared recipe.
2. Spawn the **idea-extractor** agent via the Agent tool with:
   - `brief` (either the raw `$ARGUMENTS` or the clarified brief produced in Step 1.5). If it's a clarified brief, prefix it with: *"The following is a clarified brief produced from a user conversation. Treat the Synthesis section as the canonical ask; use the transcript only for extra context."*
   - The idea ID to use
   - Instruction: "Extract and structure this idea. Use the provided idea ID. Output the complete IDEA file content."
3. Capture the extractor's output.
4. Write the idea file to `.soloflow/active/ideas/IDEA-{NNN}.md` using `noclobber` / `wx` semantics. If the target already exists (another parallel worker raced), recompute the next ID and retry.

**BUGFIX routing:** If the extractor classified the idea as BUGFIX, tell the user: "This looks like a bug. Consider `/soloflow:quick` for faster resolution." Then stop — do not proceed to research.

## Step 3: Human Checkpoint — Idea Review

Print a prose summary of the idea first so the user has context:
- Type and classification
- Slices (with value statements)
- Assumptions that need validation

Do NOT print the open questions as prose — they go into the structured picker below.

Then make a **single batched `AskUserQuestion` call** whose questions list is built in this order:

1. **One question per `open_questions` entry** from the extractor output, in order. For each:
   - `question`: the `question` field verbatim
   - `header`: a short label derived from the question (≤20 chars)
   - `options`: the extractor's `candidates` array if present (2–4 concrete candidate answers). Always rely on the `AskUserQuestion` tool's built-in free-form fallback so the user can type their own answer. If `candidates` is absent or empty, pass an empty options list and the user will answer free-form.
2. **Final question — the proceed picker.** Read the extractor's `research_recommendation` and `research_rationale` from the idea file frontmatter. Print a one-line recommendation before the question:
   - If `recommended`: *"Research recommended — {research_rationale}"*
   - If `not_needed`: *"Research likely not needed — {research_rationale}"*

   Resolve `research_enabled` per the config resolution recipe
   (`.soloflow/config.json` → `config/defaults.yaml` → fallback `true`) reading
   `phases.research`. If `research_enabled === false`, omit the
   "Approve + Research" option entirely — research is globally disabled for
   this project.

   Question: "How should we proceed with IDEA-{NNN}?" with options:
   - **Approve + Research** — run external research next. Label with `(recommended)` if `research_recommendation` is `recommended`. *(Omitted when `phases.research === false`.)*
   - **Approve (skip research)** — stop here; idea is ready for `/soloflow:planner`. Label with `(recommended)` if `research_recommendation` is `not_needed` or if `phases.research === false`.
   - **Modify** — update slices, answer questions, add constraints
   - **Reject** — delete the idea file and stop

If the extractor produced zero open questions, the batch degenerates to just the proceed picker — that's fine.

The tool call blocks until the user responds to every question — do not proceed until it returns.

**After the tool returns, update the idea file:**
- For each answered open question, append `**Answer:** {user response}` beneath the question under `## Open Questions` in the body, and mirror the answer into the YAML frontmatter as `open_questions[i].answer`.
- If every open question got an answer, flip `status: draft` → `status: answered`. Otherwise leave status unchanged.

**Then branch on the proceed answer:**
- **Approve + Research** → continue to Step 4.
- **Approve (skip research)** → skip Step 4, go to Step 4.5.
- **Modify** → use `AskUserQuestion` follow-ups (or a free-form question) to collect the specific modifications, update the idea file, then re-present Step 3's batched picker. Loop until the user approves or rejects.
- **Reject** → delete the idea file and stop.

## Step 4: Research (if selected)

If the user chose "Approve + Research":

1. Spawn the **shadow-researcher** agent via the Agent tool (`subagent_type: "shadow-researcher"`) with:
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
