---
name: visual-verify
description: This skill should be used when verifying UI changes visually using Maestro CLI (mobile) or Playwright MCP (web). Provides patterns for availability checks, screenshot capture, view hierarchy inspection, and ephemeral-flow ad-hoc navigation.
version: 0.3.0
---

# Visual Verification

This skill provides patterns for visually verifying UI changes using the **Maestro CLI** (mobile apps) and **Playwright MCP** (web apps).

Mobile verification runs entirely through the Maestro CLI (no MCP server required). Web verification uses the Playwright MCP server.

## Availability Checks

Always verify tools are installed before attempting verification.

**Maestro (mobile):**
1. Run `which maestro` via Bash. If not found, Maestro is not installed — skip mobile verification.
2. Probe for a running simulator/emulator:
   ```bash
   IOS=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted || true)
   AND=$(adb devices 2>/dev/null | awk '$2=="device"' | wc -l | tr -d ' ' || true)
   ```
   If `IOS == 0` and `AND == 0`, skip mobile verification — no device to drive. Report "skipped — no simulator/emulator booted."

**Playwright (web):**
1. Run `which npx` via Bash. If not found, Playwright cannot run — skip web verification.
2. Attempt a simple navigation as a probe. If the MCP server is not running, skip web verification.

If a tool is not available, report clearly: "Visual verification skipped — [tool] not installed / simulator not booted / MCP server not available." Do not treat this as a failure.

## Maestro Patterns (Mobile)

All Maestro verification is invoked via Bash. The CLI talks to an already-booted iOS simulator or Android emulator via `idb_companion` / `adb`.

### Element Presence Check — `maestro hierarchy`

Use `maestro hierarchy` to dump the current view hierarchy as plain text. Typical size is ~200–600 tokens depending on screen complexity — still far cheaper than a screenshot (~1600 tokens) for element presence, text content, and accessibility-label checks.

```bash
maestro hierarchy > /tmp/sf-maestro-hier-$$.txt
# Then Read the file (or pipe through grep for specific testIDs/labels)
```

Use this for: confirming buttons exist, checking text content, verifying layout structure, reading accessibility labels.

### Screen Capture

Use screenshots only when acceptance criteria require checking visual appearance that hierarchy data cannot answer: colors, images, animations, visual styling.

**iOS simulator:**
```bash
SHOT=$(mktemp /tmp/sf-shot-XXXXXX.png)
xcrun simctl io booted screenshot "$SHOT"
sips -Z 1400 "$SHOT" > /dev/null
# Then Read $SHOT as an image
```

**Android emulator:**
```bash
SHOT=$(mktemp /tmp/sf-shot-XXXXXX.png)
adb exec-out screencap -p > "$SHOT"
sips -Z 1400 "$SHOT" > /dev/null   # or: convert "$SHOT" -resize 1400x "$SHOT" on Linux
# Then Read $SHOT as an image
```

Downsizing to 1400px longest edge keeps the image readable while managing token cost.

**Multi-booted iOS:** If `xcrun simctl list devices booted | grep -c Booted` returns ≥2, `booted` errors with "multiple booted devices." Pick the first UDID explicitly:
```bash
UDID=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/{print $2; exit}')
xcrun simctl io "$UDID" screenshot "$SHOT"
```

Cap at resolved `verification.visual_screenshot_budget` screenshots per verification run (fallback: 3) to manage token budget. Resolve per the recipe in [docs/CUSTOMIZATION.md#config-resolution](../../docs/CUSTOMIZATION.md).

### Flow Execution — `maestro test`

Use `maestro test` to execute pre-written Maestro YAML flows. Resolve `verification.visual_maestro_flow_dirs` per the config recipe (fallback: `["maestro/", ".maestro/", "test/maestro/"]`) and search those directories.

```bash
maestro test maestro/signin-happy-path.yaml
echo "exit=$?"
```

Exit code `0` = all steps passed. Non-zero = a step failed; stdout/stderr identifies which step and why.

List available flows with Glob, then match flow names to the feature being verified. If a relevant flow exists, prefer it over ad-hoc verification — flows are repeatable and maintained by the project.

### Ad-hoc Navigation — Ephemeral Flow Pattern

Maestro has no one-shot CLI for individual taps/inputs. Ad-hoc interactions use an **ephemeral flow** written to a tmp path, executed with `maestro test`, then discarded.

```bash
FLOW=$(mktemp /tmp/sf-maestro-XXXXXX.yaml)
cat > "$FLOW" <<'EOF'
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- inputText: "test@example.com"
- tapOn: "Continue"
EOF
maestro test "$FLOW" 2>&1 | tee /tmp/sf-maestro-last.log
EXIT=$?
rm -f "$FLOW"
```

After the ephemeral flow lands the app on the target screen, run `maestro hierarchy` (or a screenshot) to verify state.

**`appId` resolution order:**
1. Read `verification.visual_mobile_app_id` from `.soloflow/config.json` (optional config key).
2. If null/missing, grep existing flows in `verification.visual_maestro_flow_dirs` for the first `appId:` line:
   ```bash
   grep -h '^appId:' maestro/*.yaml .maestro/*.yaml test/maestro/*.yaml 2>/dev/null | head -1
   ```
3. Else skip with `skipped_unable` and message: "cannot determine appId; set `verification.visual_mobile_app_id` or add a Maestro flow with `appId`."

**Serialize Maestro calls.** `maestro test` and `maestro hierarchy` both hold a device lock via `idb_companion`. Do not run two Maestro CLI commands in parallel against the same device.

**Animations:** Before capturing a hierarchy or screenshot right after a tap, either include `waitForAnimationToEnd` inside the flow or add a brief `sleep 0.5` in Bash — otherwise you may capture a mid-transition frame.

## Playwright Patterns (Web)

### Page Verification
1. Navigate to the relevant URL
2. Check element visibility and text content
3. Read page content to verify data rendering
4. Execute JavaScript if needed for dynamic checks

### Visual Capture
Take screenshots only when visual appearance must be verified. For content and structure checks, reading page content is more token-efficient.

## Token Budget Strategy

Prefer cheaper operations first:
1. **`maestro hierarchy`** (~200–600 tokens plain text) — for element presence, layout, accessibility
2. **Page content reading** (variable) — for text content, data verification
3. **Screenshot capture** (~1600 tokens after downsize) — only for visual appearance checks

A typical verification should use 1–2 hierarchy inspections and at most `verification.visual_screenshot_budget` screenshots (default 3). If you find yourself taking more screenshots, reconsider whether hierarchy data or page content would suffice.

## Mapping Results to Criteria

Every visual check must map to a specific acceptance criterion from the task plan. Structure your findings as:
- **Criterion:** "{what was being checked}"
- **Method:** hierarchy inspection / screenshot / flow execution
- **Result:** PASS or FAIL with specific evidence
