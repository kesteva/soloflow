---
description: Check for SoloFlow updates and show the right command to run
allowed-tools: [Read, Bash]
model: sonnet
---

# /soloflow:update

Check whether a newer version of SoloFlow is available and tell the user how
to install it. **This command is informational** — it never executes the
update itself, because the right command depends on the install path and (for
the plugin path) cannot be invoked programmatically by Claude.

---

## Step 1: Refresh the version cache

Run via Bash:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update/check-version.js" --force
```

Parse the JSON line on stdout. Fields you care about:
- `current_version`
- `latest_version`
- `update_available`

If stdout is empty (`{}`) or missing fields, treat it as "could not check" and
report:

```
Could not check for updates (network error or version unresolvable).
Try again later, or visit https://github.com/kesteva/soloflow for the
current version.
```

Then stop.

## Step 2: If already up to date

If `update_available` is `false`:

```
SoloFlow is up to date (v<current_version>).
```

Stop.

## Step 3: If an update is available

Detect install type via Bash:

```bash
test -f .claude/soloflow-install/VERSION && echo "script" || echo "plugin"
```

Print a header:

```
SoloFlow v<current_version> → v<latest_version> is available.
```

Then, **best-effort**, fetch a CHANGELOG snippet for the new version:

```bash
curl -fsS --max-time 3 https://raw.githubusercontent.com/kesteva/soloflow/main/CHANGELOG.md \
  | awk -v v="<latest_version>" '
      $0 ~ "^## \\[" v "\\]" { p=1; print; next }
      p && /^## \[/ { exit }
      p { print }
    '
```

If the snippet is non-empty, display it under a `### What's new` heading. If
the curl fails or the snippet is empty, skip this section silently.

## Step 4: Show the right install command

**Plugin install** (no `.claude/soloflow-install/VERSION` present):

```
To update, run inside Claude Code:

    /plugin update soloflow@soloflow

(Claude can't invoke `/plugin` commands for you — please type the command
yourself.)
```

**Script install** (`.claude/soloflow-install/VERSION` exists):

```
To update, run from your shell:

    git -C /tmp/soloflow pull || git clone https://github.com/kesteva/soloflow /tmp/soloflow
    bash /tmp/soloflow/scripts/update.sh "$(pwd)"

This re-runs the vendored installer against this project. `.soloflow/` state
is not touched.
```

## Step 5: Do not execute the update

Do not run `/plugin update`, `bash update.sh`, or any other update command on
behalf of the user. Display the command and stop. Even if the user follows
up with "go ahead" in this turn, ask them to run it themselves — Claude can't
restart its own plugin runtime, and the script-install path needs the user
to choose where to clone the source.
