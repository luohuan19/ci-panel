# Never Weaken Tests to Make Them Pass

## Status in This Repository

**This repository currently has no test files.** `vitest` is present as a frontend
dev dependency but no suite is wired up. This rule is forward-looking: it applies
in full the moment any test is added, and it also governs how tests get introduced.

## Core Rule

**Never modify, weaken, skip, or delete a test in order to make it pass.**

A failing test is information. Suppressing it destroys that information and ships
the underlying defect.

## When a Test Fails

1. **Investigate the root cause** — is the code wrong, or is the test wrong?
2. **If the code is wrong** — fix the code, not the test
3. **If the test is genuinely incorrect** — **inform the user before editing it** and explain why the test expectation is wrong
4. **Never silently modify test expectations** to make a failing test pass

```text
Test fails
├─ Code bug → Fix the code
└─ Test bug → Tell the user FIRST, then fix with approval
    ├─ Explain what the test asserts
    ├─ Explain why that assertion is wrong
    └─ Propose the corrected expectation
```

## Specifically Forbidden Without Approval

- Loosening an assertion (exact value → `toBeTruthy()`, `toBeDefined()`, or a range)
- Adding `.skip` / `.todo` / `.only`, or commenting a test out
- Widening a timeout to hide a real hang or race
- Deleting a test case that a change made inconvenient
- Replacing a real implementation with a mock purely so the assertion passes
- Adding `@ts-expect-error`, `@ts-ignore`, or `any` inside a test to silence a type
  error that reflects a genuine signature mismatch (see `core-development.md` —
  the same "fix, don't suppress" rule applies)

## When Adding Tests

- A new test must fail for the right reason before it passes. If it passes against
  broken code, it is not testing what you think it is.
- Assert on real behaviour, not on the implementation restated. A test that mirrors
  the implementation line-for-line cannot detect a bug in it.
- Cover the failure path too — the panel/daemon boundary and file/shell handling are
  where validation errors matter most (see `.cursor/rules/backend-daemon-panel-standards.mdc`).

## Applies To

All test types, once they exist: unit tests, Vue component tests, panel/daemon API
tests, and end-to-end tests — across `panel/`, `daemon/`, `frontend/`, and `common/`.
