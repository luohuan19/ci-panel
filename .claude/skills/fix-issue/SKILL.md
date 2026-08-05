---
name: fix-issue
description: Fix a GitHub issue on pypto-tools/ci-panel by fetching content, creating a branch, planning the fix, and implementing it. Use when the user asks to fix a specific issue number or work on a GitHub issue.
argument-hint: [issue-number]
---

# ci-panel Issue Fix Workflow

Fetch a GitHub issue, create a branch, plan, and implement the fix.

## Prerequisites

- **`gh` CLI lives at `~/.local/bin/gh`** and is NOT on the default PATH. Either
  call it by full path or `export PATH="$HOME/.local/bin:$PATH"` first.
- **`gh` is authenticated** with write access to `pypto-tools/ci-panel` (scopes:
  `repo`, `read:org`, `gist`, `admin:public_key`).
- **Work against `origin` (`pypto-tools/ci-panel`) only.**
- **Default branch is `master`.**
- **No project board, by design.** Track with labels and assignees only. Never
  add project-field steps or `--project` flags.

## Task Tracking

Create tasks to track progress through this workflow:

1. Fetch issue & create branch
2. Plan the fix
3. Self-assign (and set In Progress, if a board is configured)
4. Implement the fix
5. Verify (`verify` skill)
6. Commit changes (`git-commit` skill)
7. Create PR (optional, `github-pr` skill)

## Step 1: Check gh CLI Authentication

```bash
export PATH="$HOME/.local/bin:$PATH"
gh auth status
```

**If not authenticated**, prompt the user:

```text
gh CLI is not authenticated. Please run: gh auth login
```

**Stop here if not authenticated** — the user must log in first.

## Step 2: Fetch Issue Content and Check Ownership

```bash
gh issue view ISSUE_NUMBER --repo pypto-tools/ci-panel \
  --json number,title,body,state,labels,assignees
gh issue view ISSUE_NUMBER --repo pypto-tools/ci-panel --comments
```

**Parse** number, title, description, state, labels, assignees, and all
comments — comments often carry clarifications, repro steps, or design
decisions that are critical context. **If the issue is closed**, ask the user
whether they still want to work on it.

**Check for existing ownership**:

1. Check the `assignees` field.
2. If **already assigned** to someone else: warn the user with
   `AskUserQuestion` — show who owns it, and ask whether to proceed or stop.
   ci-panel is single-developer, so this will usually be a no-op.

## Step 3: Create Issue Branch

**Branch naming**: `issue-{number}-{short-description}`

```bash
git checkout master && git pull origin master
ISSUE_NUM=123
BRANCH_NAME="issue-${ISSUE_NUM}-fix-runner-status"
git checkout -b "$BRANCH_NAME"
```

Pull from **`origin`**.

## Step 4: Enter Plan Mode

Use `EnterPlanMode` to design the fix.

**Plan should cover**: root cause (for bugs); which of the four packages are
affected — `panel/` (web backend), `daemon/` (node agent), `frontend/` (Vue 3),
`common/` (shared types); files to change; implementation strategy; and any
documentation updates.

**Cross-package consistency**: a change to an HTTP route in
`panel/src/app/routers/` or `daemon/src/routers/` usually needs a matching
change in `frontend/src/services/apis/`; shared types live in `common/src/`.

Follow `.claude/rules/plans-and-proposals.md` — plans must include concrete
code snippets, file paths, and before/after comparisons.

## Step 5: Self-Assign

**Do this immediately after plan approval, before writing any code.**

```bash
gh issue edit ISSUE_NUMBER --repo pypto-tools/ci-panel --add-assignee @me
```

Assigning yourself is the whole ownership signal here — there is no board to
update.

## Step 6: Implement the Fix

1. Make the code changes per the approved plan
2. Follow the conventions in `.claude/rules/`
3. Keep `common/src/` types in sync with both consumers
4. Update documentation if behavior changed

## Step 7: Verify

```text
/verify
```

The `verify` skill runs the real gate: all four vitest suites, `type-check` on
all four, `lint` on `frontend` (the only package with one), plus `build` for each
affected package. Never report a check you did not run. Fix every failure before
committing.

When the issue is a defect, add the failing spec **before** the fix and confirm
it goes red against the unfixed code — see `.claude/rules/no-test-tampering.md`.

Every package is testable now, `panel/` included, so a defect fix always has a
spec that can go red. Prefer pinning shared behaviour in `common/` where it
belongs to more than one package.

## Step 8: Commit Changes

```text
/git-commit
```

**Commit message format**:

```text
fix(scope): Brief description

Fixes #ISSUE_NUMBER

Detailed explanation of the fix.
```

Use the affected package as the scope: `panel`, `daemon`, `frontend`, `common`.

## Step 9: Create PR (Optional)

```text
/github-pr
```

The PR must target **`pypto-tools/ci-panel` `master`** and reference the issue:
"Fixes #ISSUE_NUMBER".

## Common Issue Types

| Type | Approach |
| ---- | -------- |
| Bug fix | Reproduce, find root cause, write the failing spec, fix, verify via suites/type-check/lint/build |
| Feature request | Plan the API shape across packages, implement, update docs |
| Refactoring | Plan changes, keep the public HTTP/type surface stable |
| Documentation | Fix/improve docs, verify examples match the current code |

## Checklist

- [ ] gh CLI authenticated
- [ ] Issue fetched from `pypto-tools/ci-panel` and understood
- [ ] Checked for existing assignees
- [ ] Issue branch created from latest `origin/master`
- [ ] Plan created and approved
- [ ] Issue self-assigned (board update only if configured)
- [ ] Fix implemented following `.claude/rules/`
- [ ] Cross-package consistency maintained (routers ↔ API client ↔ common types)
- [ ] `/verify` passes: all four suites, type-check, lint, build
- [ ] For a defect: a spec goes red against the unfixed code
- [ ] Changes committed with issue reference
- [ ] Documentation updated if needed

## Remember

**Reference the issue** as `Fixes #ISSUE_NUMBER` in the commit message and PR
description so GitHub auto-links and closes it.
