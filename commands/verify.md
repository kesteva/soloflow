---
description: Run standalone visual verification using Maestro MCP (mobile) and/or Playwright MCP (web)
argument-hint: <screen or feature to verify>
allowed-tools: [Read, Glob, Grep, Bash, AskUserQuestion]
---

# /soloflow:verify

You are running standalone visual verification. The user wants to visually check a screen or feature without running the full workflow.

The target to verify is: **$ARGUMENTS**

## Step 1: Check Availability

Before any MCP interaction, confirm the tools are installed:

**For mobile verification:**
1. Run `which maestro` via Bash
2. If not found, report: "Maestro is not installed. Install it with: `curl -Ls 'https://get.maestro.mobile.dev' | bash`"
3. If found, attempt `inspect_view_hierarchy` as a probe. If MCP server is not running, report: "Maestro MCP server is not available. Ensure Maestro MCP is configured in your settings."

**For web verification:**
1. Run `which npx` via Bash
2. If not found, report: "npx is not available. Ensure Node.js is installed."
3. If found, attempt a Playwright probe. If MCP server is not running, report: "Playwright MCP server is not available. Ensure Playwright MCP is configured in your settings."

If neither tool is available, report this to the user and stop.

## Step 2: Discover Context

1. Search the codebase for files related to the user's target (use Grep/Glob)
2. Search for existing Maestro flows in `maestro/`, `.maestro/`, `test/maestro/` that match the target
3. Determine whether this is a mobile UI, web UI, or both

## Step 3: Run Visual Verification

### Mobile (Maestro)
If relevant to the target:
1. If a matching Maestro flow exists, run it with `run_flow` and report the result
2. If no flow exists, verify ad-hoc:
   - `launch_app` to start the app
   - Navigate to the target screen using `tap_on` / `input_text`
   - `inspect_view_hierarchy` to check element presence and layout (~50 tokens)
   - `take_screenshot` only if visual appearance needs checking (~1600 tokens, limit to 3)

### Web (Playwright)
If relevant to the target:
1. Navigate to the relevant URL
2. Check element visibility and content
3. Take a screenshot if visual appearance must be verified

## Step 4: Report

Output a visual verification report:

```
## Visual Verification Report
- **Target:** {what was verified}
- **Method:** Maestro | Playwright | Both

### Results
- {check 1}: PASS | FAIL — {evidence}
- {check 2}: PASS | FAIL — {evidence}

### Screenshots
- {description of each screenshot taken, if any}

### Issues Found
- {any problems discovered, or "None"}
```

## Important Notes

- Do NOT run `maestro test` via Bash while using Maestro MCP tools — both use port 7001.
- Prefer `inspect_view_hierarchy` over `take_screenshot` when checking element presence or layout.
- If the user's target is too vague, ask for clarification before proceeding. Prefer the **AskUserQuestion** tool when the clarification can be framed as a choice between candidate targets; use a free-form text question only when genuinely open-ended.
