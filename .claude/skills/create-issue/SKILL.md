---
name: create-issue
description: Create a GitHub issue on luohuan19/ci-panel following the repository's issue templates. Classifies the issue type, fills required fields per template, creates it via gh CLI, and applies labels. Use when the user wants to file a bug, request a feature, or create any GitHub issue.
---

# Create GitHub Issue (ci-panel)

## Prerequisites

- **`gh` CLI lives at `~/.local/bin/gh`** and is NOT on the default PATH. Either
  call it by full path or `export PATH="$HOME/.local/bin:$PATH"` first.
- **`gh` is authenticated** as `luohuan19` (scopes: `repo`, `read:org`, `gist`,
  `admin:public_key`).
- **File issues against `origin` (`luohuan19/ci-panel`) only.** The `upstream`
  remote is `MCSManager/MCSManager` — a third-party project. **Never** open an
  issue or PR there.
- **No project board, by design.** Track with labels and assignees only. Never
  add project-field steps or `--project` flags.

## Templates

`.github/ISSUE_TEMPLATE/` holds `bug-report.yml` (label `bug`) and `feature.yml`
(label `enhancement`), both written for ci-panel. `config.yml` allows blank
issues and links to upstream MCSManager for problems that are not ci-panel's.

**Never hardcode a template list** — always `ls .github/ISSUE_TEMPLATE/` at run
time and read the files you find. Templates change; this note may go stale.

## Step 1: Authenticate

```bash
export PATH="$HOME/.local/bin:$PATH"
gh auth status
```

If not authenticated, tell the user to run `gh auth login` and **stop**.

If the user wants the optional project-board step, the token also needs the
`project` scope (`gh auth refresh -s project`).

## Step 2: Check for Existing Issues

**Launch a `general-purpose` agent** (via the `Agent` tool, **model: haiku**) to
run the dedup check. This keeps the main context clean.

**Agent prompt must include:** the issue summary/keywords, and these exact
instructions:

> **IMPORTANT: ONLY use `gh` CLI commands (at `~/.local/bin/gh`). Do NOT read
> source code or explore the repository. Your sole job is to check GitHub issues
> for duplicates.**
>
> **Step A** — scan open issue titles:
>
> ```bash
> gh issue list --repo luohuan19/ci-panel --state open --limit 200 \
>   --json number,title,labels \
>   --jq '.[] | "\(.number)\t\(.title)\t\(.labels | map(.name) | join(","))"'
> ```
>
> **Step B** — deep-read candidates only (max 3), body only, skip
> `--comments` unless the body is ambiguous:
>
> ```bash
> gh issue view NUMBER --repo luohuan19/ci-panel
> ```
>
> Return EXACTLY one of: `DUPLICATE #N` (same root cause/request),
> `RELATED #N1 #N2 ...` (related but different), or `NO_MATCH`. Keep your
> response to 1-3 sentences plus the verdict.

### How to act on the result

- `DUPLICATE #N` → Do NOT create. Tell the user the existing issue. **Stop.**
- `RELATED #N1 ...` → Proceed, reference in body: `Related: #N1, #N2`
- `NO_MATCH` → Proceed normally.

> The repository has very few commits and may have zero issues. An empty issue
> list is a normal `NO_MATCH`, not an error.

## Step 3: Classify the Issue

Read `.github/ISSUE_TEMPLATE/` (Step 0 above) and pick the template whose
`name` / `description` best matches the user's request:

| Template | Use when | Label (from the template's own `labels:` key) |
| -------- | -------- | --------------------------------------------- |
| `bug-report.yml` | Something is broken | `bug` |
| `feature.yml` | New capability or enhancement | `enhancement` |

Neither fits? `config.yml` allows blank issues — create one without a template.

**Read the labels from the template file itself** — do not assume. If the
directory has been rewritten since this skill was authored, follow the new
files, not this table.

**If ambiguous**, ask the user to clarify using `AskUserQuestion`.

## Step 4: Gather Required Fields

Each template marks required fields with `required: true`. You MUST fill every
one. **Ask the user** for anything you cannot infer; use `AskUserQuestion` for
dropdowns.

**Auto-fillable fields:**

| Field | How to get it |
| ----- | ------------- |
| Commit | `git rev-parse --short HEAD` |
| Branch | `git rev-parse --abbrev-ref HEAD` (default is `master`) |
| Title prefix | the template's `title:` value, e.g. `[Bug] ` |
| Platform | `uname -s -m`; `head -2 /etc/os-release` |
| Node version | `node --version` |
| Component | Infer from the paths involved; ask if ambiguous |

The `Logs` field is optional. If you include logs, **redact tokens, internal
hostnames, and IPs first** — this repository is public.

## Step 5: Format the Issue Body

`gh issue create` takes a markdown body, not YAML form fields. Mirror each
template field label as a markdown `###` heading with the content beneath it.
For dropdown fields, state the selected value as plain text.

## Step 6: Create the Issue

```bash
gh issue create --repo luohuan19/ci-panel \
  --title "[Bug] Short description" \
  --label "bug" \
  --body "$(cat <<'EOF'
### Component

Daemon (node agent)

### Commit

53fb1ea

### Platform

Ubuntu 22.04 aarch64

### Node version

v20.11.0

### What happened

Actual: ...
Expected: ...
EOF
)"
```

Capture the issue number from the output URL
(`https://github.com/luohuan19/ci-panel/issues/123` → `ISSUE_NUMBER=123`) and
show the URL to the user.

## Step 7: Apply Labels

This repo uses **no project board** — labels and assignees are the whole
tracking mechanism.

The templates already apply their own label (`bug-report.yml` → `bug`,
`feature.yml` → `enhancement`), so this step only adds anything extra.

**Applying a label that does not exist fails the command.** The repo carries
GitHub's defaults only — read the real list before adding anything:

```bash
gh label list --repo luohuan19/ci-panel
gh issue edit <number> --repo luohuan19/ci-panel --add-label "documentation"
```

Useful extras from the defaults: `documentation`, `question`, `help wanted`,
`good first issue`. If the user wants a label that does not exist, offer to
create it (`gh label create <name> --repo luohuan19/ci-panel`) rather than
silently substituting a different one.

## Checklist

- [ ] gh CLI authenticated (and `project` scope if Step 7 is enabled)
- [ ] `.github/ISSUE_TEMPLATE/` read at run time, not assumed from this file
- [ ] Searched for existing issues (no duplicate)
- [ ] Issue classified, all required fields filled
- [ ] Issue created on `luohuan19/ci-panel` (never `upstream`)
- [ ] Labels applied (no project board — labels and assignees are the tracking)
