---
name: github-pr
description: Create a GitHub pull request after committing, rebasing, and pushing changes. Use when the user asks to create a PR, submit changes for review, or open a pull request.
---

# ci-panel GitHub Pull Request Workflow

## Prerequisites

- **`gh` CLI lives at `~/.local/bin/gh`** and is NOT on the default PATH. Either
  call it by full path or `export PATH="$HOME/.local/bin:$PATH"` first.
- **`gh` is authenticated** as `luohuan19` (scopes: `repo`, `read:org`, `gist`,
  `admin:public_key`). If `gh auth status` ever fails, stop and tell the user —
  do not attempt manual API calls with curl.
- **No GitHub Project board, by design.** Never add `--project` to `gh pr create`
  or introduce project-field steps.

## ⚠️ Remote topology — read before rebasing

```text
origin    git@…:luohuan19/ci-panel.git      ← OUR repo. PR target. Default branch: master
upstream  git@github.com:MCSManager/MCSManager.git  ← third-party project we forked
```

- **Always PR into `origin` (`luohuan19/ci-panel`), branch `master`.**
- **NEVER open a PR against `upstream` (MCSManager) and NEVER rebase onto it.**
  It is an unrelated third-party project; rebasing onto it would rewrite history
  against a foreign tree.
- Base ref for every operation in this skill is `origin/master`.

## Task Tracking

Create tasks to track progress through this workflow:

1. Prepare branch & commit
2. Check for existing PR
3. Fetch origin
4. Rebase onto origin/master
5. Push to remote
6. Create PR

## Step 1: Prepare Branch and Commit

**Check current state:**

```bash
BRANCH_NAME=$(git branch --show-current)
git status --porcelain          # Check for uncommitted changes
git fetch origin                # NEVER `git fetch upstream` for PR work
BASE_REF=origin/master
git rev-list HEAD --not "$BASE_REF" --count   # Commits ahead of base
```

A branch "needs a new branch" when it is effectively on master — either the branch
name is `master`/`main`, **or** it has zero commits ahead of `origin/master`.

**Decision logic:**

| Needs new branch? | Uncommitted changes? | Action |
| ----------------- | -------------------- | ------ |
| Yes | Yes | Create new branch, then commit via `/git-commit` |
| Yes | No | Error — nothing to PR. Tell user to make changes first |
| No | Yes | Commit on current branch via `/git-commit` |
| No | No | Skip — already committed on a feature branch |

**If a new branch is needed:**

1. Auto-generate a branch name with a meaningful prefix (`feat/`, `fix/`,
   `refactor/`, `chore/`, `docs/`) based on the changes — do NOT ask the user
2. Create and switch to it:

```bash
git checkout -b <branch-name>
```

3. Commit via the `/git-commit` skill (mandatory — it runs `code-review` and `verify`)

**If on an existing feature branch with uncommitted changes:** commit via
`/git-commit` before proceeding.

## Step 2: Check for Existing PR

```bash
BRANCH_NAME=$(git branch --show-current)
gh pr list --head "$BRANCH_NAME" --state open
```

**If PR exists**: display with `gh pr view` and exit immediately.

## Step 3: Fetch origin

```bash
git fetch origin
```

Do not add or fetch a PR base from `upstream`. The `upstream` remote already
exists and points at MCSManager — leave it alone.

## Step 4: Rebase

```bash
git rebase origin/master
```

**On conflicts:**

```bash
git status                     # View conflicts
# Edit files, remove markers
git add path/to/resolved/file
git rebase --continue
# If stuck: git rebase --abort
```

After a rebase that touched source files, re-run the `verify` skill before pushing.

## Step 5: Push

```bash
# First push
git push --set-upstream origin BRANCH_NAME

# After rebase (use --force-with-lease, NOT --force)
git push --force-with-lease origin BRANCH_NAME
```

⚠️ **Use `--force-with-lease`** — safer than `--force`, fails if the remote has
unexpected changes.

## Step 6: Create PR

**Check gh CLI:**

```bash
gh auth status
```

**If gh is unavailable or unauthenticated**: report it and give the manual URL:
`https://github.com/luohuan19/ci-panel/compare/master...BRANCH_NAME`

**If gh available:**

```bash
gh pr create \
  --repo luohuan19/ci-panel \
  --base master \
  --title "Brief description of changes" \
  --body "$(cat <<'EOF'
## Summary
- Key change 1
- Key change 2

## Verification
- [ ] `npm run type-check --prefix frontend` passes
- [ ] `npm run lint --prefix frontend` clean
- [ ] `npm run build --prefix <affected packages>` succeeds
- [ ] Code review completed

## Related Issues
Fixes #ISSUE_NUMBER (if applicable)
EOF
)"
```

`--repo` and `--base` are explicit on purpose: without them `gh` may infer the
`upstream` (MCSManager) remote as the PR base.

**PR Title/Body**: auto-extracted from commit messages since `origin/master`.
This repo has **no test suite** — never write "all tests pass" in a PR body.

**Important:**

- ❌ Do NOT add footers like "🤖 Generated with Claude Code" or any AI attribution
- ✅ Keep PR descriptions professional and focused on technical content only

## Common Issues

| Issue | Solution |
| ----- | -------- |
| PR already exists | `gh pr view` then exit |
| PR opened against MCSManager | Close it. Re-create with `--repo luohuan19/ci-panel --base master` |
| Merge conflicts | Resolve, `git add`, `git rebase --continue` |
| Push rejected | `git push --force-with-lease` |
| `gh: command not found` | Use `~/.local/bin/gh` |
| gh not authenticated | Tell user to run `gh auth login` or set `GH_TOKEN` |

## Checklist

- [ ] Branch prepared (created off `origin/master` if needed)
- [ ] Changes committed via `/git-commit`
- [ ] No existing PR for branch
- [ ] Fetched `origin` and rebased onto `origin/master` (never `upstream`)
- [ ] Conflicts resolved, `verify` re-run if sources changed
- [ ] Pushed with `--force-with-lease`
- [ ] PR created against `luohuan19/ci-panel` base `master`
