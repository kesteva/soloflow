---
description: Run standalone visual verification using Maestro MCP (mobile, falls back to CLI) and/or Playwright MCP (web)
argument-hint: <screen or feature to verify>
allowed-tools: [Read, Glob, Grep, Bash, AskUserQuestion, mcp__maestro__*, mcp__playwright__*]
---

# /soloflow:verify

You are running standalone visual verification. The user wants to visually check a screen or feature without running the full workflow.

The target to verify is: **$ARGUMENTS**

## Step 0: Check initialization

If `.soloflow/` does not exist, report: "SoloFlow not initialized. Run `/soloflow:init` first." and stop.

## Step 1: Check Availability

Pick a mobile path **once** per the **Path Selection** recipe in `skills/visual-verify/SKILL.md`, then probe web.

**For mobile verification (MCP preferred, CLI fallback):**
1. **Probe MCP.** Call `mcp__maestro__list_devices`. If it returns a result, set `USE_MAESTRO_MCP=true`. If the tool is unbound or the call errors, continue.
2. **Probe CLI.** Run `which maestro` via Bash. If not found AND MCP probe failed, report: "Maestro is not available via MCP or CLI. Install the CLI with: `curl -Ls 'https://get.maestro.mobile.dev' | bash`, or register the MCP server with: `claude mcp add --scope user maestro maestro mcp`."
3. **Probe device.** Regardless of path, at least one simulator/emulator must be booted:
   ```bash
   IOS=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
   AND=$(adb devices 2>/dev/null | awk '$2=="device"' | wc -l | tr -d ' ' || true)
   ```
   If both are zero, report: "No simulator/emulator booted. Start one with: `open -a Simulator` (iOS) or `emulator -avd <name>` (Android)." (MCP's `start_device` can also boot one for you if you prefer — but the user likely wants an explicit choice.)

**For web verification:**
1. Run `which npx` via Bash.
2. If not found, report: "npx is not available. Ensure Node.js is installed."
3. If found, attempt a Playwright MCP probe. If the MCP server is not running, report: "Playwright MCP server is not available. Ensure Playwright MCP is configured in your settings."

If neither mobile nor web tooling is available, report this to the user and stop.

## Step 2: Discover Context

1. Search the codebase for files related to the user's target (use Grep/Glob)
2. Search for existing Maestro flows in `maestro/`, `.maestro/`, `test/maestro/` that match the target
3. Determine whether this is a mobile UI, web UI, or both

## Step 3: Run Visual Verification

### Mobile (Maestro — MCP preferred, CLI fallback)
Stay on the path chosen in Step 1. See `skills/visual-verify/SKILL.md` for exact tool signatures and command patterns.

**MCP path:**
1. If a matching Maestro flow exists, call `mcp__maestro__run_flow_files(device_id, flow_files=[<path>])` and report the per-step results.
2. If no flow exists, compose inline YAML (`launchApp` + `tapOn` / `inputText`) and call `mcp__maestro__run_flow(device_id, flow_yaml=<body>)`.
3. Call `mcp__maestro__inspect_view_hierarchy(device_id)` to check element presence and layout (CSV, ~50 tokens).
4. Call `mcp__maestro__take_screenshot(device_id)` only if visual appearance needs checking (limit to 3).

**CLI path:**
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

- Prefer hierarchy inspection over screenshot capture when checking element presence or layout — cheaper on tokens and more structured. The MCP path's hierarchy is ~4–10× cheaper than the CLI's.
- Never mix Maestro MCP and CLI in the same run — both bind port 7001. Path Selection picks one; stay on it.
- Within a single path, serialize against the same device — don't run two Maestro operations in parallel.
- If the user's target is too vague, ask for clarification before proceeding. Prefer the **AskUserQuestion** tool when the clarification can be framed as a choice between candidate targets; use a free-form text question only when genuinely open-ended.
