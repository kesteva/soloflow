---
description: Run standalone visual verification using Maestro CLI (mobile) and/or Playwright MCP (web)
argument-hint: <screen or feature to verify>
allowed-tools: [Read, Glob, Grep, Bash, AskUserQuestion]
---

# /soloflow:verify

You are running standalone visual verification. The user wants to visually check a screen or feature without running the full workflow.

The target to verify is: **$ARGUMENTS**

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Check Availability

Confirm the tools are installed:

**For mobile verification:**
1. Run `which maestro` via Bash.
2. If not found, report: "Maestro is not installed. Install it with: `curl -Ls 'https://get.maestro.mobile.dev' | bash`"
3. If found, probe for a booted simulator/emulator:
   ```bash
   IOS=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
   AND=$(adb devices 2>/dev/null | awk '$2=="device"' | wc -l | tr -d ' ' || true)
   ```
   If both are zero, report: "No simulator/emulator booted. Start one with: `open -a Simulator` (iOS) or `emulator -avd <name>` (Android)."

**For web verification:**
1. Run `which npx` via Bash.
2. If not found, report: "npx is not available. Ensure Node.js is installed."
3. If found, attempt a Playwright MCP probe. If the MCP server is not running, report: "Playwright MCP server is not available. Ensure Playwright MCP is configured in your settings."

If neither tool is available, report this to the user and stop.

## Step 2: Discover Context

1. Search the codebase for files related to the user's target (use Grep/Glob)
2. Search for existing Maestro flows in `maestro/`, `.maestro/`, `test/maestro/` that match the target
3. Determine whether this is a mobile UI, web UI, or both

## Step 3: Run Visual Verification

### Mobile (Maestro CLI)
If relevant to the target (see `skills/visual-verify/SKILL.md` for exact command patterns):
1. If a matching Maestro flow exists, run `maestro test <flow.yaml>` via Bash and report the exit code + any failing-step output.
2. If no flow exists, verify ad-hoc using the **ephemeral-flow pattern**:
   - Resolve `appId` from `verification.visual_mobile_app_id` or existing flows.
   - Write a minimal YAML (`launchApp` + `tapOn` / `inputText`) to `/tmp/sf-maestro-*.yaml`, run `maestro test`, remove the file.
   - Run `maestro hierarchy` to check element presence and layout (~200–600 tokens plain text).
   - Capture a screenshot only if visual appearance needs checking (~1600 tokens after `sips -Z 1400`, limit to 3):
     - iOS: `xcrun simctl io booted screenshot <path>`
     - Android: `adb exec-out screencap -p > <path>`

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

- Prefer `maestro hierarchy` over screenshot capture when checking element presence or layout — cheaper on tokens and more structured.
- Serialize Maestro CLI calls; never run two `maestro` commands in parallel against the same device.
- If the user's target is too vague, ask for clarification before proceeding. Prefer the **AskUserQuestion** tool when the clarification can be framed as a choice between candidate targets; use a free-form text question only when genuinely open-ended.
