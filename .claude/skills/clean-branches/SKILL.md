---
name: clean-branches
description: Remove stale local and remote git branches that have been merged into master. Detects regular merges and squash merges. Cleans up origin branches and prunes tracking refs. Use when the user asks to clean up branches, remove merged branches, or tidy up git.
---

# Clean Merged Git Branches

## Overview

Identifies and removes branches whose work is already in `master` — both local
branches and remote branches on `origin`. Detects squash-merged branches that
`git branch --merged` cannot detect. Never touches the `upstream` remote.

## Prerequisites

- **`gh` CLI lives at `~/.local/bin/gh`**, not on the default PATH. Export
  `PATH="$HOME/.local/bin:$PATH"` or call it by full path.
- **`gh` is authenticated** as `luohuan19` — squash-merge detection needs it. If
  `gh auth status` ever fails, fall back to `git branch --merged` detection only
  and flag the reduced coverage to the user.

## ⚠️ Remote topology

```text
origin    luohuan19/ci-panel            ← OUR repo. Branches here MAY be deleted.
upstream  MCSManager/MCSManager         ← third-party. NEVER delete anything here.
```

The default branch is **`master`**, not `main`.

## Step 1: Identify Remotes

```bash
git remote -v
```

Confirm `origin` is `luohuan19/ci-panel`. **Only `origin` branches are candidates
for deletion.** If `origin` does not point at `luohuan19/ci-panel`, stop and ask
the user — do not guess.

## Step 2: Gather Branch Information

Run in parallel:

```bash
# Local: regular merges
git branch --merged master | grep -v '^\*' | grep -vx '  master'

# Local: all branches (excluding current and master)
git branch | grep -v '^\*' | grep -vx '  master'

# Remote: all origin branches (exclude master/HEAD)
git fetch origin
git branch -r --list 'origin/*' | grep -vw 'origin/master' | grep -vw 'origin/HEAD'

# Stale remote tracking refs
git remote prune origin --dry-run
```

**If no local or remote branches exist besides master**: inform the user and exit.

## Step 3: Detect Squash-Merged Branches

For each branch (local or remote-only) NOT in the `--merged` list, check GitHub:

```bash
gh pr list --repo luohuan19/ci-panel --head "<branch-name>" \
  --state merged --json number,title,headRefOid --limit 1
```

For remote branches, strip the `origin/` prefix before querying.

**Branch-reuse safeguard:** If a merged PR is found, compare the branch tip SHA
with the PR's `headRefOid`. If they differ, the branch may have new commits after
the PR merged — treat it as unfinished, not safe to delete.

**Categorize each branch:**

| Category | Criteria | Safe to delete? |
| -------- | -------- | --------------- |
| Merged (git) | In `git branch --merged master` | Yes |
| Squash-merged | `gh pr list --state merged` returns a PR | Yes |
| No merged PR | No merged PR found | Possibly unfinished work |

## Step 4: Present Summary to User

Display a combined table showing both local and remote status:

```text
**Merged branches (safe to delete):**
| # | Branch | Local | Remote | PR | How merged |
|---|--------|-------|--------|----|------------|
| 1 | feat/node-status | yes | yes | #12 | squash-merged |
| 2 | old-branch | yes | no | — | regular merge |
| 3 | docs/readme-zh | no | yes | #15 | squash-merged |

**Unfinished branches (no merged PR):**
| # | Branch | Local | Remote | Last Commit |
|---|--------|-------|--------|-------------|
| 4 | wip-terminal | yes | no | abc1234 "wip" |
```

## Step 5: Ask for Approval

Use `AskUserQuestion` with options:

| Option | Description |
| ------ | ----------- |
| All merged branches (Recommended) | Delete merged branches (local + on `origin`). Keep unfinished. |
| All branches | Delete everything including unfinished work. |
| Let me pick | User specifies which branches to delete. |

**Never delete branches without explicit user approval.** This is a solo-developer
repo — an unfinished branch may be the only copy of that work.

## Step 6: Delete and Prune

After approval:

```bash
# Delete local branches
git branch -D <branch1> <branch2> ...

# Delete remote branches on origin (only if they exist on the remote)
for b in <branch1> <branch2> ...; do
  if git show-ref --verify --quiet "refs/remotes/origin/$b"; then
    git push origin --delete "$b"
  fi
done

# Prune stale remote tracking refs
git remote prune origin
```

Never run `git push upstream --delete` — `upstream` is MCSManager's repo.

Report results: local branches deleted, remote branches deleted, refs pruned.

## Important Constraints

- **Never delete anything on `upstream`** (MCSManager) — only on `origin`
- **Never delete `master` or `HEAD`** on any remote
- **Current branch**: warn the user if the current branch is not `master`; it
  cannot be deleted while checked out
- **`gh` unavailable/unauthenticated**: skip squash-merge detection; inform the
  user that only `git --merged` detection was used
- **No remote for a branch**: skip remote deletion for that branch silently

## Checklist

- [ ] `origin` confirmed as `luohuan19/ci-panel`; `upstream` untouched
- [ ] All local and remote branches categorized against `master`
- [ ] Summary table presented (local/remote status per branch)
- [ ] User approved the deletion list
- [ ] Local branches deleted
- [ ] `origin` branches deleted
- [ ] Stale refs pruned
- [ ] Results reported
