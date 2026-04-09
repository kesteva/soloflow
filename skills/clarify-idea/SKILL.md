---
name: clarify-idea
description: This skill should be used when a raw user idea is ambiguous and needs conversational disambiguation before structured extraction or planning. Provides a clarification loop with ambiguity checklist, scope-decomposition gate, one-question-at-a-time probing, and a readiness gate.
version: 0.1.0
---

# Clarify Idea

This skill encodes a short conversational clarification loop to run **before** structured idea extraction or task refinement, when the raw input is too ambiguous to extract cleanly. It is **instructional** — the calling agent drives the loop using its own `AskUserQuestion` tool. This skill does not spawn subagents.

## When to invoke

Apply this checklist to the raw input. If **any** item is missing or unclear, invoke the loop:

- **Goal** — what outcome does the user want?
- **Target user / surface** — who/what is affected? Which screen, file, subsystem?
- **Success signal** — how will the user know it worked?
- **Scope boundary** — what is explicitly in or out of scope?
- **Grounding** — does the input reference concrete files, functions, features, or existing behavior?

If all five are present, **skip this skill** and proceed directly to extraction. Running the loop on an already-clear input is a cost, not a benefit.

Opt-out signals the caller must honor:
- `--skip-clarify` anywhere in the arguments
- `config.phases.clarify === false` in `.soloflow/config.json` or `config/defaults.yaml`

## Anti-pattern

> "This is too simple to need clarification."

The ambiguity checklist is the judge, not your intuition. Cheap to run, cheap to skip. Do not debate whether to invoke — apply the checklist.

## Scope-decomposition gate (runs first)

If the input spans **multiple independent subsystems or deliverables** (e.g., "redesign onboarding AND add a notifications center AND refactor the API client"), stop immediately. Do NOT begin clarification on the whole thing.

Use `AskUserQuestion`:
- **Question:** "This request covers multiple independent pieces. Which one do you want to work on first?"
- **Header:** "Pick one"
- **Options:** one per detected subsystem, plus a free-form "something else" fallback.

Clarify only the selected piece. The others can be captured as separate ideas later.

## Clarification loop

Rules (hard):

1. **One `AskUserQuestion` at a time.** Never batch clarification questions. Each answer informs the next question.
2. **Prefer multiple-choice.** Offer 2–4 concrete, mutually distinct candidate answers, plus the built-in free-form fallback the tool provides. Avoid open-ended prompts unless the space is genuinely unbounded.
3. **Follow threads.** An answer may reveal a new ambiguity — follow it. Examples:
   - Vague term → "When you say X, do you mean A, B, or C?"
   - Interpretation fork → "Two reasonable reads of this: which did you mean?"
   - Missing example → "Would {concrete scenario} count as success?"
4. **Lightweight research is allowed, not required.** One targeted `Grep` / `Glob` (or a single `WebSearch` for unfamiliar domain terms) is fine to frame better candidate answers. Never use research as a substitute for asking the user.
5. **Do not propose slices, tasks, or implementations.** This skill only disambiguates the ask. Structuring is the idea-extractor's job; planning is the task-refiner's job.

Keep going until the checklist at the top of this file is satisfied — every item has a clear answer.

## Readiness gate (HARD-GATE)

Once you believe the checklist is satisfied, present an explicit confirmation via `AskUserQuestion`:

- **Question:** "I think I understand what you want. Ready to extract the idea?"
- **Header:** "Ready?"
- **Options:**
  - "Extract now" — proceed
  - "Keep clarifying" — loop returns to the clarification loop
  - "Cancel" — abort; caller stops without writing anything

**You MUST NOT proceed to extraction until "Extract now" is selected.** This is a hard gate — the anti-pattern is declaring readiness yourself and skipping the user confirmation.

If the user picks "Keep clarifying," return to the clarification loop. There is no retry limit; loop until the user confirms.

## Output: clarified brief

When the gate passes, produce a **clarified brief** in this exact shape and hand it to the caller:

```markdown
## Raw Input

{Verbatim $ARGUMENTS the user passed in}

## Clarification Transcript

- Q: {question 1}
  A: {user answer 1}
- Q: {question 2}
  A: {user answer 2}
{...}

## Synthesis

{One concise paragraph restating the now-clarified ask, incorporating every
answer above. This is the canonical interpretation the downstream
idea-extractor should treat as the ask.}
```

The synthesis paragraph is canonical. The raw input and transcript are context only.

## Reuse

This skill is designed to be invoked by any command that accepts a free-form user ask and needs to disambiguate before structuring — currently `/soloflow:idea-extractor`, and reusable by `/soloflow:quick` for ambiguous bug reports.
