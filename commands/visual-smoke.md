---
description: Smoke-test visual verification — verify Maestro (mobile) and Playwright (web) are working end-to-end
allowed-tools: [Read, Glob, Grep, Bash, mcp__maestro__*, mcp__playwright__*]
model: sonnet
---

# /soloflow:visual-smoke

Diagnostic command that exercises the visual-verification stack end-to-end
to confirm both **Maestro** (mobile) and **Playwright** (web) are wired up
correctly. Unlike `/soloflow:verify`, this is **not** about checking a
specific feature — it answers the prior question: *is my visual-verification
environment actually working before I trust it for real verification runs?*

The command is fully automated, requires no arguments, and does **not**
depend on `.soloflow/` being initialized. It can run on a fresh machine to
diagnose setup issues.

Per-platform result is one of:

- `PASS` — every probe succeeded; visual verification works on this platform.
- `SKIP` — platform tooling intentionally absent (e.g., no Playwright MCP
  registered, no simulator booted). Reported with the exact remediation.
- `FAIL` — tooling is present but a probe errored mid-run. Reported with
  the failing step and error text.

Always run BOTH platforms (or attempt to). Never short-circuit one because
the other passed/failed.

---

## Step 1: Maestro path probe

Pick a single mobile path up front. Mixing MCP and CLI in one run causes
port-7001 contention (see `skills/visual-verify/SKILL.md` for the rule).

1. **MCP probe.** Call `mcp__maestro__list_devices`. If it returns a result
   without erroring, set `MAESTRO_PATH = "mcp"` and capture the device list.
2. **CLI probe (only if MCP failed).** Run `which maestro` via Bash. If a
   path is returned, set `MAESTRO_PATH = "cli"`. Otherwise set
   `MAESTRO_PATH = "none"`.

If `MAESTRO_PATH = "none"`: emit `mobile_result = SKIP` with the message:

> Maestro not available. Install the CLI with `curl -Ls https://get.maestro.mobile.dev | bash`, or register the MCP server with `claude mcp add --scope user maestro maestro mcp`.

Skip to Step 4 (Playwright). Do not abort the command.

## Step 2: Maestro device probe

Confirm at least one simulator or emulator is booted. Run via Bash:

```bash
IOS=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
AND=$(adb devices 2>/dev/null | awk '$2=="device"' | wc -l | tr -d ' ' || true)
echo "ios_booted=$IOS android_attached=$AND"
```

If both counters are `0`: emit `mobile_result = SKIP` with the message:

> No iOS simulator or Android emulator detected. Boot one before running visual verification: `open -a Simulator` (iOS) or `emulator -avd <name>` (Android). MCP's `start_device` can also boot one if you prefer.

Record the counts for the final report. Skip to Step 4.

If at least one device is available, continue.

## Step 3: Maestro smoke test

Drive the booted device with the cheapest non-trivial sequence that proves
the integration end-to-end. **Do not launch any project app** — this command
must work without `verification.visual_mobile_app_id` being set, on any
machine. Operate on whatever screen is currently visible (likely the home
screen) — the smoke test only verifies the *integration*, not app content.

### MCP path (`MAESTRO_PATH = "mcp"`)

1. From Step 1's `list_devices` result, pick the first device with status
   `"booted"` (or equivalent). Capture its `device_id` as `DEVICE_ID`.
2. **Hierarchy probe.** Call
   `mcp__maestro__inspect_view_hierarchy(device_id=DEVICE_ID)`. Confirm
   the response is non-empty (at least one node).
3. **Screenshot probe.** Call
   `mcp__maestro__take_screenshot(device_id=DEVICE_ID)`. Confirm an image
   was returned.

If any step errors, capture the error message and emit
`mobile_result = FAIL` with the failing step + error text.

If all three succeed, emit `mobile_result = PASS` with one-line evidence:
*"MCP path; device_id=…; hierarchy={N} nodes; screenshot captured."*

### CLI path (`MAESTRO_PATH = "cli"`)

1. **Hierarchy probe.** Run via Bash:
   ```bash
   maestro hierarchy > /tmp/sf-smoke-hier-$$.txt 2>&1
   echo "exit=$?"
   wc -l /tmp/sf-smoke-hier-$$.txt
   rm -f /tmp/sf-smoke-hier-$$.txt
   ```
   Confirm `exit=0` and the file had non-zero lines.
2. **Screenshot probe.** Pick the available platform (iOS preferred if both
   booted):
   ```bash
   SHOT=$(mktemp /tmp/sf-smoke-shot-XXXXXX.png)
   if [ "$IOS" -ge 1 ]; then
     UDID=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/{print $2; exit}')
     xcrun simctl io "$UDID" screenshot "$SHOT" 2>&1
   else
     adb exec-out screencap -p > "$SHOT" 2>&1
   fi
   echo "exit=$?"
   ls -l "$SHOT"
   rm -f "$SHOT"
   ```
   Confirm `exit=0` and the file was non-zero bytes before deletion.

If any step errors, capture stderr and emit `mobile_result = FAIL`.

If both succeed, emit `mobile_result = PASS` with one-line evidence:
*"CLI path; platform={ios|android}; hierarchy ok; screenshot captured."*

## Step 4: Playwright path probe

Playwright has no CLI fallback.

1. Run `which npx` via Bash. If absent: emit `web_result = SKIP` with:
   > Node.js / npx not found. Install Node.js from https://nodejs.org before running web visual verification.

   Skip to Step 6.

2. Attempt a lightweight `mcp__playwright__*` call. Use
   `mcp__playwright__browser_navigate` to navigate to `about:blank`. If
   the tool is unbound or the call errors, emit `web_result = SKIP` with:
   > Playwright MCP not registered. Register with `claude mcp add --scope user playwright npx @playwright/mcp@latest`, then restart Claude Code.

   Skip to Step 6.

If the navigate succeeds, continue.

## Step 5: Playwright smoke test

Drive the browser through a complete navigate → snapshot → screenshot
sequence on a self-contained page. Use a `data:` URI so the smoke test has
no external network dependency.

1. **Navigate.** Call `mcp__playwright__browser_navigate` with URL:
   ```
   data:text/html,<html><head><title>SoloFlow Visual Smoke</title></head><body><h1 id=heading>SoloFlow Visual Smoke Test OK</h1></body></html>
   ```
2. **Snapshot probe.** Call `mcp__playwright__browser_snapshot`. Confirm
   the response contains the literal string `SoloFlow Visual Smoke Test OK`
   (the H1 text we just set). This proves DOM access works.
3. **Screenshot probe.** Call `mcp__playwright__browser_take_screenshot`.
   Confirm an image was returned.
4. **Cleanup.** Call `mcp__playwright__browser_close` to release the
   browser context.

If any step errors, capture the error and emit `web_result = FAIL` with
the failing step + error text.

If all four succeed, emit `web_result = PASS` with one-line evidence:
*"Playwright MCP; navigated to data URI; snapshot matched; screenshot captured."*

## Step 6: Report

Print a summary block. Use plain text — no progress spinners, no nested
formatting. The user reads this once and acts on it.

```
## Visual Verification Smoke Test

Mobile (Maestro):  {PASS|SKIP|FAIL}
  Path:    {mcp|cli|none}
  Devices: {N} iOS simulator(s), {N} Android device(s)
  {evidence or remediation line}

Web (Playwright):  {PASS|SKIP|FAIL}
  {evidence or remediation line}

---

Overall: {READY|PARTIAL|NOT READY}
```

Overall mapping:
- **READY** — both platforms PASS, OR one PASSes and the other SKIPs (this
  is the expected state for a project that only uses one platform).
- **PARTIAL** — one PASS and one FAIL.
- **NOT READY** — both SKIP or both FAIL.

If `Overall = NOT READY` and the user explicitly cares about visual
verification (config has `verification.visual_mobile=true` or
`verification.visual_web=true`), append one extra line:

> Visual verification is enabled in your config but the environment isn't
> ready. Run `/soloflow:verify` to debug, or re-run `/soloflow:init` to
> walk through MCP registration and dependency checks.

Reading `.soloflow/config.json` for that final hint is best-effort — if the
file is missing, omit the hint silently.

## Important notes

- **Don't run real verification flows.** This is purely an integration probe.
  Don't open project apps, don't navigate to project URLs, don't depend on
  any project-specific config beyond the optional config-aware hint at the
  end of Step 6.
- **Don't mix paths.** If MCP probe succeeds in Step 1, every Maestro call
  for the rest of the run uses MCP. If it falls through to CLI, every call
  uses CLI. Never switch mid-run (port 7001 contention).
- **Always close the Playwright browser** in Step 5.4 even if earlier
  Playwright steps fail — leaving a browser orphaned consumes memory and
  can block subsequent runs.
- **Never write to `.soloflow/`** during this command. It's a diagnostic;
  it has no business mutating state.
