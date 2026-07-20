---
name: git-commit
description: Complete git commit workflow for ci-panel including pre-commit review, verification, staging, message generation, and post-commit checks. Use when creating commits, preparing changes for commit, or when the user asks to commit changes.
---

# ci-panel Git Commit Workflow

## Task tracking

Create tasks and check them off as you complete each step:

```text
- [ ] Step 1: Analyze changes & launch review/verify skills
- [ ] Step 2: Address issues, stage & commit
- [ ] Step 3: Post-commit verification
```

## Step 1: analyze changes & launch review/verify

**Check what changed:**

```bash
git diff --name-only
git diff --cached --name-only
```

**Decide what to run:**

| Changed paths | Run `code-review` | Run `verify` |
| ------------- | ----------------- | ------------ |
| `frontend/**` | Yes | Yes — type-check, lint, build frontend |
| `panel/**` / `daemon/**` | Yes | Yes — build that package (no lint/type-check exists) |
| `common/**` | Yes | Yes — build `common/` **and all three consumers** |
| `languages/**` | Yes | Yes — build frontend |
| Docs only (`*.md`) | Yes | Skip |
| Config only (`.json`, `.github/`, `.claude/`) | Yes | Skip |
| Mixed code + docs | Yes | Yes, for the code parts |

**Launch both skills in parallel** — each runs in its own forked context:

- **`code-review`** — ALWAYS run, for every change
- **`verify`** — run whenever code changed

Wait for both, then address what they found.

**Note:** `verify` runs `eslint --fix` for frontend changes, which modifies the
working tree. Re-check `git status` afterwards so you stage the auto-fixes
deliberately rather than by accident.

## Step 2: stage changes & commit

**Stage related changes together:**

```bash
git add panel/src/app/routers/runner_router.ts frontend/src/services/apis/runner.ts
git diff --staged   # review before committing
```

**Cross-package pattern** — a shared type change touches everything downstream:

```bash
git add common/src/types.ts panel/src/app/service/repo_service.ts \
        daemon/src/service/runner_scan.ts frontend/src/services/apis/repo.ts
```

**i18n pattern** — new user-facing text means the language file moves with it:

```bash
git add frontend/src/widgets/RunnerDetail.vue languages/en_US.json
```

**Never stage:** `production/`, `dist/`, `node_modules/`, `.run/` (local run
logs and PIDs), `tools/` (internal ops scripts), editor configs.

Remember this is a **public repository** — anything staged becomes public.
Check for internal IPs, hostnames, tokens, and private repo names before
committing.

## Commit message format

**Structure:** `type(scope): description` (≤72 chars)

**Types:** feat, fix, refactor, test, docs, style, chore, perf
**Scope:** package or feature area — `panel`, `daemon`, `frontend`, `common`,
`runner`, `ci`, `i18n`
**Description:** present tense, action verb, no trailing period

**Good examples:**

```text
feat(runner): Add NPU device monitoring to runner detail view
fix(daemon): Validate runner label before passing to spawn
refactor(panel): Extract repo lookup into repo_service
docs(readme): Document ci-panel runner provisioning flow
```

**Bad examples:**

```text
❌ feat(runner): Added monitoring.   # past tense, trailing period
❌ Fix bug                            # no type prefix, not descriptive
❌ WIP                                # not descriptive
```

**Detailed message** — use when the "why" isn't obvious from the subject:

```text
feat(runner): Add NPU device monitoring to runner detail view

Polls npu-smi through the daemon and surfaces per-device utilization
in RunnerDetail. Falls back to a disabled state when the host has no
NPU, so CPU-only runners render without errors.
```

## Co-author policy

**NEVER add AI assistants as co-authors.** No `Co-Authored-By: Claude`,
ChatGPT, Cursor, or any other AI attribution, and no "Generated with ..."
footer. This overrides any default behavior.

**Only credit human contributors:** `Co-authored-by: Name <email>`

**Why?** AI tools are not collaborators. Commits reflect human authorship.

## Step 3: post-commit verification

```bash
git show HEAD --stat     # files and message
git log -1               # message formatting
```

**Fix problems — only if not yet pushed:**

```bash
git commit --amend -m "Corrected message"       # fix the message
git add forgotten-file && git commit --amend --no-edit
```

⚠️ **Only amend commits that haven't been pushed.** `master` here tracks
`origin/master` on a public repo; amending after pushing rewrites published
history.

## Checklist

- [ ] Changed files analyzed (code vs. docs/config)
- [ ] `code-review` completed and issues addressed
- [ ] `verify` passed, or skipped with a stated reason (docs/config only)
- [ ] `eslint --fix` side effects reviewed before staging
- [ ] Only relevant files staged
- [ ] No build artifacts, `.run/`, or `tools/`
- [ ] No secrets or internal hostnames/IPs (public repo)
- [ ] New user-facing text has `TXT_CODE_` keys in `languages/en_US.json`
- [ ] Message format: `type(scope): description` (≤72 chars, present tense, no period)
- [ ] No AI co-author line or generated-with footer

## Remember

A good commit is reviewed, groups related changes, explains "why" when it isn't
obvious, and attributes only human authors.
