# Plans and Proposals

## Core Principle

**When presenting a plan, proposal, or implementation strategy, always include detailed, comprehensive examples.**

Abstract descriptions are insufficient. Every proposed change must be grounded in concrete code snippets, file paths, and before/after comparisons so the user can evaluate the plan accurately.

## Requirements

### 1. Show Concrete Code, Not Abstract Descriptions

````text
# ❌ Vague
"We should validate the runner label before registering it."

# ✅ Detailed
"Add a `validateRunnerLabel` helper to `panel/src/app/utils/runner.ts`:

```ts
// panel/src/app/utils/runner.ts
const RUNNER_LABEL_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export function validateRunnerLabel(label: string): void {
  if (!RUNNER_LABEL_PATTERN.test(label)) {
    throw new Error($t("TXT_CODE_INVALID_RUNNER_LABEL", { label }));
  }
}
```

Call it from the register route in `panel/src/app/routers/runner_router.ts`:

```ts
validateRunnerLabel(ctx.request.body.label);
```

Add the message to `languages/en_us.json`:

```json
{ "TXT_CODE_INVALID_RUNNER_LABEL": "Invalid runner label: {{label}}" }
```
"
````

### 2. Include Before/After for Modifications

When proposing changes to existing code, show the current state and the proposed state:

````text
# ❌ Vague
"Refactor the status panel to show the queue length."

# ✅ Detailed
"Modify `frontend/src/components/RunnerStatus.vue`:

Before:
```vue
<script setup lang="ts">
const props = defineProps<{ status: RunnerStatus }>();
</script>

<template>
  <span>{{ t("TXT_CODE_RUNNER_STATE", { state: props.status.state }) }}</span>
</template>
```

After:
```vue
<script setup lang="ts">
const props = defineProps<{ status: RunnerStatus; queued: number }>();
</script>

<template>
  <span>{{ t("TXT_CODE_RUNNER_STATE", { state: props.status.state }) }}</span>
  <span>{{ t("TXT_CODE_RUNNER_QUEUED", { count: props.queued }) }}</span>
</template>
```
"
````

### 3. List All Affected Files With Specific Changes

````text
# ❌ Vague
"This touches the panel, the frontend, and the shared types."

# ✅ Detailed
"Files to modify:
1. `common/src/index.ts` — Add `queued: number` to the `RunnerStatus` type
2. `panel/src/app/service/runner_service.ts` — Populate `queued` from the daemon response
3. `frontend/src/components/RunnerStatus.vue` — Render the queue count (new prop)
4. `languages/en_us.json` — Add `TXT_CODE_RUNNER_QUEUED`

New files:
- None
"
````

### 4. Specify Step Order and Dependencies

Remember: the four packages are **not** npm workspaces — each of `panel/`, `daemon/`,
`frontend/`, `common/` has its own `npm install`. State explicitly which package a
command runs in.

````text
# ❌ Vague
"Update the shared types, then the backend and frontend."

# ✅ Detailed
"Implementation order:
1. `common/src/index.ts`: extend `RunnerStatus` — must come first, both sides depend on it
2. Rebuild common: `cd common && npm run build` — panel/frontend consume the built output
3. `panel/src/app/service/runner_service.ts`: populate the new field — depends on step 2
4. `frontend/src/components/RunnerStatus.vue`: consume the field via props
5. `languages/en_us.json`: add the new `TXT_CODE_*` key
6. Type-check each package it touches: `cd panel && npx tsc --noEmit`, `cd frontend && npm run type-check`
"
````

### 5. Address Edge Cases and Alternatives

When the plan involves design decisions, explain the trade-offs:

````text
# ❌ Vague
"We could poll or push."

# ✅ Detailed
"Two approaches for surfacing the queue length:

Option A — Panel polls the daemon on an interval (`panel/src/app/service/runner_service.ts`):
```ts
setInterval(() => void this.refreshQueue(), 5_000);
```
Pro: no daemon protocol change
Con: adds a long-lived timer that needs explicit teardown, and adds up to 5s of staleness

Option B — Daemon pushes on the existing socket channel:
```ts
socket.emit("runner/queue", { queued: this.queue.length });
```
Pro: no timer, no staleness
Con: requires a new event on both sides and a fallback for older daemons

Recommendation: Option B — the panel↔daemon socket already carries status events,
so this reuses an existing channel instead of adding a new polling loop that would
need cleanup logic.
"
````

### 6. Describe the Verification Strategy

The project currently has no test files, so state exactly how the change will be
verified — type checks, lint, and the concrete manual path through the UI or API.

````text
# ❌ Vague
"I will verify it works."

# ✅ Detailed
"Verification:
1. Type-check: `cd common && npm run build`, `cd panel && npx tsc --noEmit`,
   `cd frontend && npm run type-check`
2. Manual: start the panel and daemon, open the node's runner page, confirm the
   queue count renders and updates when a job is queued
3. i18n: confirm the new `TXT_CODE_RUNNER_QUEUED` key resolves (no raw key shown)
"

If tests exist by the time you plan the change, describe which test files you will
add or update instead — see `no-test-tampering.md`.
````

## Summary

| Element | Required in Plan |
| ------- | ---------------- |
| Code snippets | Yes — show actual proposed code |
| File paths | Yes — pinpoint every change |
| Before/after comparisons | Yes — for modifications |
| Step ordering | Yes — with per-package commands and dependencies |
| Edge cases and alternatives | Yes — with trade-off analysis |
| Verification strategy | Yes — type-check, lint, and manual steps |
