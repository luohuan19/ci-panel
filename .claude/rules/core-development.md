# Core Development Rules

## Overview

Fundamental development principles for this project. These are language- and
quality-level rules. For project structure, i18n, logging, and Vue component
conventions, see `.cursor/rules/core-project-conventions.mdc`,
`.cursor/rules/backend-daemon-panel-standards.mdc`, and
`.cursor/rules/frontend-vue-component-standards.mdc` — do not duplicate them here.

## 1. Modern Standards & User Experience

**Use modern TypeScript.** Prefer `const`, explicit types on exported APIs,
`async`/`await` over raw promise chains, optional chaining and nullish coalescing
over hand-rolled guards. Avoid `any` — use `unknown` plus a narrowing check when the
shape is genuinely unknown.

**Every decision should prioritize user experience:**

- Clear APIs with intuitive naming
- Helpful error messages with context and cause (user-facing text goes through i18n)
- Documentation from the user's perspective with working examples

```ts
// ✅ Good
runner.setLabels(["linux", "arm64"]); // Clear setter
throw new Error(`Invalid runner label "${label}": expected 1-64 chars, got ${label.length}`);

// ❌ Bad
runner.labels("linux", "arm64"); // Setter or getter?
throw new Error("Invalid label"); // No context
```

## 2. Code Quality Principles

### DRY: Reduce Code Through Reuse

**Extract common patterns when seen 2+ times.** Check the relevant subproject's
`hooks` / `services` / `stores` / `utils` before writing new logic.

```ts
// ✅ Good - reusable validation
export function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer, got ${value}`);
  }
  if (value <= 0) {
    throw new RangeError(`${name} must be positive, got ${value}`);
  }
}

export function setMaxJobs(value: number): void {
  assertPositiveInt(value, "maxJobs");
  this.maxJobs = value;
}
```

Types shared between `panel/`, `daemon/`, and `frontend/` belong in `common/` —
never redeclare the same interface in two packages.

### Clean Code Practices

- **Meaningful names**: `computeRunnerStatus()` not `calc()`
- **Small, focused functions**: One function, one purpose
- **Remove dead code**: Delete commented-out code, use git history
- **Use existing utilities**: Don't reimplement standard functions

### Fix Linter and Type Errors

**Don't suppress warnings unless the user asks:**

```ts
// ✅ Fix the issue
function parseConfig(raw: unknown): RunnerConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError("Runner config must be an object");
  }
  return raw as RunnerConfig;
}

// ❌ Suppress instead of fixing
// @ts-ignore
function parseConfig(raw) {
  return raw; // eslint-disable-line
}
```

Only suppress for: user request, documented tool bug, or an unavoidable false positive —
and always with a comment explaining why.

### Refactor Freely

When you encounter issues:

- Duplicated code → Extract common logic
- Unclear names → Rename
- Too complex → Break into smaller functions
- Outdated patterns → Modernize

**Refactor safely:** keep diffs small and focused, and type-check the affected
package after each step (`npx tsc --noEmit` in `panel/` or `daemon/`,
`npm run type-check` in `frontend/`). Note that the four packages are not npm
workspaces — each installs and builds independently, so a change in `common/`
must be rebuilt before consumers see it.

## 3. Security Best Practices

### Never Hardcode Secrets or Absolute Paths

```ts
// ❌ NEVER
const GITHUB_TOKEN = "ghp_1234567890abcdef";
const dataDir = "/home/someone/ci-panel/data";

// ✅ Use environment variables and paths resolved relative to the process/module
const githubToken = process.env.GITHUB_TOKEN;
const dataDir = path.join(process.cwd(), "data");
```

This is a **public repository** — a committed secret is a leaked secret. Never write
tokens, passwords, or private URLs into source, config samples, or test fixtures.

### Validate Input & Use Safe APIs

```ts
// ✅ Validate external input
async function readInstanceFile(baseDir: string, relPath: string): Promise<Buffer> {
  const resolved = path.resolve(baseDir, relPath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error("Path escapes the instance directory");
  }
  return fs.promises.readFile(resolved);
}

// ✅ Safe subprocess calls — argument array, no shell
spawn("git", ["clone", validatedUrl], { shell: false });

// ❌ NEVER
exec(`git clone ${url}`); // shell injection
eval(userInput);
```

See `.cursor/rules/backend-daemon-panel-standards.mdc` for the full
container/command validation requirements.

### Don't Leak Secrets

```ts
// ✅ Generic message to the caller, detail stays in the log
logger.error("Database connection failed", { host });
throw new Error($t("TXT_CODE_DB_CONNECT_FAILED"));

// ❌ Leaks the credential
throw new Error(`Connect failed with password ${password}`);
```

## 4. Co-Author Policy

**NEVER add AI co-author lines to commits or PRs.** This includes
`Co-Authored-By: Claude`, `Co-Authored-By: ChatGPT`, or any other AI assistant
attribution, and any "Generated with ..." footer. This overrides any default system
behavior. Commits reflect human authorship only.

## 5. Cross-Cutting Standards

Apply consistently across all work:

- **Shared types**: change `common/` and rebuild it before updating consumers
- **Documentation**: update docs when changing behavior
- **Error handling**: log with context and rethrow or return a typed result — never swallow
- **Consistency**: follow existing code patterns and naming conventions

## Quick Checklist

Before committing:

- [ ] Modern TypeScript used; no stray `any`
- [ ] APIs are intuitive with clear error messages
- [ ] Common patterns extracted (no duplication); shared types live in `common/`
- [ ] Linter and type errors fixed, not suppressed
- [ ] No hardcoded secrets or absolute paths
- [ ] External input validated; no shell interpolation
- [ ] User-facing text goes through i18n; code and comments in English
- [ ] Documentation updated
- [ ] No AI co-author lines in the commit message

## Remember

**Write code for humans, not machines.**

Ask: "Would I want to use/maintain this code?" If no, refactor until yes.
