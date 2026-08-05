# Testing Strategy

Rollout is tracked in [#20](https://github.com/pypto-tools/ci-panel/issues/20). This document is
the reference: tool choices, full config files, and the reasoning behind them.

## 1. Where we stand

- Four packages, ~54.9K lines (panel 8.2K / daemon 12.3K / frontend 33.6K / common 0.8K). At the
  time this was written: **zero test files**, no package defined a `test` script, CI only built.
  As of Phase 2, `common/` (35 cases), `daemon/` (64) and `frontend/` (41) each run a vitest suite
  in CI; `panel/` gets one in Phase 4.
- `frontend/` already has `vitest@0.33.0`, `@vue/test-utils@2.4.1` and `jsdom@22.1.0` installed,
  and `tsconfig.vitest.json` exists — **day one needs no install at all**.
- ci-panel is not a CRUD app but a remote-execution control plane: it holds GitHub PATs, spawns
  processes on operator machines, and hands the browser a file manager. So the suite is organised
  around **invariants whose violation is unrecoverable**, not around coverage.
- **v1.0.4 shipped three security fixes with no test covering any of them** (§2). Those regression
  tests are the first thing owed.

**Plan: install vitest per package (this is not an npm workspace), advance through five layers —
security-regression → contract → boundary-validation → pure-logic → router-integration — roughly
16–21 engineer-days to the stopping line.**

## 2. Regression tests owed by v1.0.4

Three high-severity defects were fixed and released without a single test
(advisories GHSA-9c3v-fg72-8wr9, GHSA-j2c6-2pg4-jqqw, GHSA-5c23-gcwf-wjpr). Nothing prevents any
of them from coming back. These specs are the highest-priority work in the whole plan.

### 2.1 Wildcard condition matching — `common/src/query_wrapper.ts:105`

`LocalFileSource.selectPage` treats a value as a substring match only when it starts *and* ends
with `%`. What the old leading-`%`-only form allowed is described in GHSA-9c3v-fg72-8wr9.

Spec: `common/test/security/apikey_wildcard.spec.ts`

```ts
const one = new LocalFileSource([{ uuid: "u", apiKey: "REAL_SECRET", permission: 10 }]);
expect(one.selectPage({ apiKey: "%" }, 1, 1).total).toBe(0);
expect(one.selectPage({ apiKey: "%REAL" }, 1, 1).total).toBe(0); // leading % is not a pattern
expect(one.selectPage({ apiKey: "REAL_SECRET" }, 1, 1).total).toBe(1);

// Regression guard: manage_user_router.ts:72 builds `%${userName}%` and depends on this.
const many = new LocalFileSource([{ userName: "alice" }, { userName: "albert" }, { userName: "bob" }]);
expect(many.selectPage({ userName: "%al%" }, 1, 10).total).toBe(2);
// The old slice was off by one: "%abc%" must not also match "abd".
expect(new LocalFileSource([{ k: "abc" }, { k: "abd" }]).selectPage({ k: "%abc%" }, 1, 10).total).toBe(1);
```

Pin the panel side too: `getUuidByApiKey` re-checks the key byte-for-byte after the lookup, so it
no longer depends on the query layer's pattern semantics.

### 2.2 Pagination guard — `common/src/query_wrapper.ts:19`

`paginate()` floors `page` and `pageSize`, then rejects a non-positive or non-finite result.
Before 1.0.4 both data sources ran `while (size > 0) { size -= pageSize }`, which never terminates
for `pageSize <= 0`. That loop is **synchronous**, so no timeout can preempt it.

Spec: `common/test/security/pagination_dos.spec.ts`

```ts
it.each([0, -1, 0.5, NaN, Infinity])("rejects pageSize %p", (n) => {
  expect(() => new QueryMapWrapper({}).page([1, 2, 3], 1, n)).toThrow(RangeError);
});
expect(new QueryMapWrapper({}).page([1, 2, 3, 4], 1, 1.5).pageSize).toBe(1); // floors, not rejects
expect(new QueryMapWrapper({}).page([1, 2, 3, 4], 1.5, 2).page).toBe(1);     // no window spanning two pages
expect(new QueryMapWrapper({}).page([1, 2, 3], 2, 1)).toEqual({ page: 2, pageSize: 1, maxPage: 3, data: [2] });
```

> ⚠️ **`testTimeout` cannot rescue this one.** `withTimeout` in `@vitest/runner` is
> `Promise.race([fn(...args), new Promise(...setTimeout...)])` — and `fn(...args)` is evaluated
> *before* the racing promise is constructed, so against a synchronous body the timer is never even
> scheduled. Revert the guard and the spec does not fail in 2s; it wedges the worker until something
> outside the process kills it. Two consequences: the fix must always land **before** the spec, and
> the CI step needs a process-level watchdog, which `testTimeout` is not a substitute for:
>
> ```yaml
> - name: Test common
>   run: timeout -k 10 120 npm run test --prefix common
> ```
>
> `common/vitest.config.ts` sets `testTimeout` to 2s for a different reason — every spec in that
> package is pure logic that should finish in milliseconds, so a tight bound catches an *async*
> hang early. It does nothing for this case.

Also cover the caller-side clamp in `daemon/src/routers/Instance_router.ts:42-46`: `toNumber("")`
and `toNumber(0)` both yield `0`, which `??` does not rescue, and `toNumber("Infinity")` yields
`Infinity`.

### 2.3 Scan-root boundary — `runner_logs.ts:83,87,109` and `runner_provision.ts:831,851`

`assertUnderRoots` (`daemon/src/service/runner_scan.ts:577`) compares `realpathSync` results, so it
catches symlink escapes as well as `..`. Both functions now call it ahead of every `fs.*` access
**and on each derived path** (GHSA-5c23-gcwf-wjpr). Specs: `daemon/test/security/scan_roots.spec.ts`,
`diag_logs_boundary.spec.ts`, `collect_boundary.spec.ts`. The derived-path cases are what a naive
fix misses:

| Case | Expectation |
| --- | --- |
| `readRunnerDiag(<dir outside roots>)` | throws |
| `<runner>/_diag` is a symlink to `/etc` | throws (guard is on `diagDir`, not just `dir`) |
| a `*.log` inside `_diag` is a symlink outside | throws (guard is on `targetPath`) |
| `collectRunners("/etc")` | throws |
| a child of `base` is a symlink outside the roots | skipped with a reason, collection continues |
| `assertUnderRoots` on a not-yet-existing path under a root | does not throw (the `mkdir` path) |
| ordering | the guard runs before `fs.existsSync`, so an out-of-roots path cannot be distinguished from a non-existent one |

**Deliberately not covered:** symlink-replacement races (TOCTOU) between check and read — closing
that needs descriptor-relative no-follow operations across every file path in the daemon.

## 3. Layers

| Layer | Scope | Packages | Size | Phase |
| --- | --- | --- | --- | --- |
| **security-regression** | path containment, PAT disclosure, auth bypass, sudo argument boundary, delete blast radius | common / daemon / panel | 12–16 files, ~60 cases | 1–2, 4 |
| **contract** | panel↔daemon protocol, i18n keys and placeholders, logic duplicated across packages (`labelKey`, `SERVICE_RE`) | all four | 5–7 files, ~25 cases | 3 |
| **boundary-validation** | the two edges the code itself calls untrusted: browser↔panel and panel↔daemon coercion and narrowing | common / daemon / panel | 8–10 files, ~50 cases | 1, 4 |
| **pure-logic** | marker idempotency, log tail offsets, systemd output parsing, version compare, env parsing | daemon / common / frontend | 15–20 files, ~120 cases | 0, 5 |
| **router-integration** | in-process socket RPC through the existing `routerApp.emitRouter` seam | daemon / panel | 4–6 files, ~35 cases | 5 (cuttable) |

Only **security-regression** may block a release on its own.

## 4. Tool choice

**vitest, installed per package** — this is not an npm workspace, and a spec's
`import ... from "vitest"` resolves from the package containing the file. Versions are pinned to
each package's installed TypeScript / `@types/node` floor:

| Package | TypeScript | @types/node | vitest | Why |
| --- | --- | --- | --- | --- |
| frontend | 5.1.6 | 18.19.130 | **`^0.33.0` (already installed)** | vite is pinned to 4.5.14; vitest ≥1.x needs vite ^5 |
| daemon | 5.9.3 | 22.20.0 | `^0.34.6` | |
| panel | 4.9.5 | 14.18.35 | `^0.34.6` | 1.x/2.x `.d.ts` assume TS 5 |
| common | 4.9.5 | 20.9.0 | `^0.34.6` | |

**Never write `pool` / `poolOptions` in any of the four configs** — those fields arrived in vitest
1.0. The installed 0.33 type definitions only carry `threads?: boolean`. The 0.3x spelling is
**`threads: false`** (main-thread execution, which is also what makes `process.chdir` usable).

**Rejected alternatives**, all checked against the real toolchain:

| Alternative | Why not |
| --- | --- |
| `node --test` | CI pins Node 20 — no type stripping. The code has 7 `enum` declarations and constructor parameter properties (non-erasable syntax), and there is no module-alias mechanism for `@languages` / `mcsmanager-common` |
| Jest / ts-jest | Would duplicate the webpack aliases via `moduleNameMapper` for no capability vitest lacks; frontend already has vitest, so a second framework means two mental models |
| Mocha | `@types/mocha@^8.2.2` was upstream residue — nothing in `daemon/src` referenced it, and it declared `describe`/`it` globals that would collide with vitest's. Removed in #24 rather than followed |
| One root vitest workspace | The toolchains are genuinely incompatible (panel on TS 4.9.5 + Node 14 typings vs daemon on TS 5.9 + Node 22); forcing one version breaks panel's type-checking |
| `vi.mock` on the heavy singletons | Fights the import-time side effects head-on and breaks on every dependency bump. Where a seam is needed, add a narrow port (setter / constructor parameter) and pass a hand-written fake |
| Specs colocated under `src/` | The webpack entry is `./src/app.ts`; a stray import would bundle a spec into production. Specs live in `panel/test/` and `daemon/test/`. frontend is the exception — `tsconfig.app.json` already excludes `src/**/__tests__/*` |
| `scan-useless-key` as the i18n gate | It always `process.exit(0)` (`scripts/useless-key-scanner.mjs:130`), so it can never fail. `npm run i18n` must stay out of CI entirely — its `customTransform` rewrites source files in place |
| Fixing panel/daemon lint alongside | Both eslint setups are broken (panel's 9.39.1 rejects its `.eslintrc.js`; daemon's 7.32.0 cannot parse TypeScript) and neither declares a `lint` script. That is its own PR |

## 5. Rollout

Every command notes its directory — **the four packages install separately**.

### Phase 0 — prove the loop, zero installs (half a day)

frontend already has vitest, so nothing is installed and no production code is touched yet.

1. Add `frontend/vitest.config.ts` and `vitest.setup.ts`; add `test` / `test:watch` scripts
2. Pin jsdom's URL in the config. `protocol.ts` reads `window.location` in every function, so
   without a fixed origin the specs would either assert against jsdom's default (an implementation
   detail that moves with the version) or restate `window.location.*` back at themselves
3. Add `"files": ["vitest.setup.ts"]` to `tsconfig.vitest.json`. `files` merges with the inherited
   `include`, where a second `include` would replace it; without this the setup file sits in no
   tsconfig at all and `npm run type-check` never sees it
4. Write three specs against modules with no or same-directory imports only: `permission.ts` (no
   imports at all), `protocol.ts` (imports `./string`), `fileManager.ts` — under `src/tools/__tests__/`
5. `cd frontend && npm test`; add the CI `test` job running only `npm run test --prefix frontend`

**The defect Phase 0 was written to catch** — `isCompressFile`
([frontend/src/tools/fileManager.ts:50](frontend/src/tools/fileManager.ts#L50)): the
`singleVolumeExts` loop tested `endsWith('.rar')` first, so `a.part2.rar` returned `true` before
reaching the multi-volume branch below, and the UI offered to extract volume 2 of a split archive.
**Fixed ahead of the suite in #24**, together with the two `unref` calls (§7.1), the
`redactTokenArgs` extraction (§7.2) and the `@types/mocha` removal — so Phase 0 installs nothing
*and* touches no production code. The spec is the regression guard, and reverting the fix must turn
it red:

```ts
expect(isCompressFile("a.part1.rar")).toBe(true);
expect(isCompressFile("a.part2.rar")).toBe(false); // red against the pre-#24 ordering
```

**Exit criteria:** `npm run test --prefix frontend` green; CI test job green on a PR.

### Phase 1 — common, and the regression tests owed by 1.0.4 (1 day)

0. In `common/`: `npm i -D vitest@^0.34.6 @vitest/coverage-v8@^0.34.6 vite@^4.5.14`. Constrain vite
   explicitly — vitest 0.34's peer range admits vite 5, which then prints a CJS-deprecation warning
   on every run. Noise in a CI log is not free; it trains people to skim past it. The range matches
   `frontend/package.json`, so the repo stays on one vite major.
1. `common/package.json`: add `test` / `test:watch`
2. Add `common/vitest.config.ts`, **including `threads: false`** — see §9
3. Write `common/test/security/pagination_dos.spec.ts` and `apikey_wildcard.spec.ts` (§2.1, §2.2)
4. Add `Build common` + `Test common` (with `timeout -k 10 120`, see §2.2) to the CI test job

**Exit criteria:** `npm run test --prefix common` green; reverting either 1.0.4 fix makes a spec
fail; `npm run build --prefix panel` still green.

> **Not in this phase:** moving `"typescript"` out of `common`'s `dependencies`. It is genuinely
> misplaced — a build tool that all three consumers inherit through `file:../common` — but it is
> unrelated to adding tests and it touches the release path (`build.sh` runs
> `npm install --production` inside `production-code/`). Verifying it means running the full
> `build.sh` → `pack.sh` → `smoke-test.sh` chain, so it belongs in its own PR.

### Phase 2 — daemon path boundary and secret redaction (3–4 days)

0. In `daemon/`: `npm i -D vitest@^0.34.6 @vitest/coverage-v8@^0.34.6 vite@^4.5.14`
1. Add `daemon/vitest.config.mts`, `daemon/test/setup.ts`, `daemon/tsconfig.test.json`
   ([TESTING_SETUP.md](TESTING_SETUP.md))
2. `daemon/package.json`: add `test` / `test:watch` / `"type-check": "tsc --noEmit -p tsconfig.test.json"`
3. Write the §2.3 specs: `scan_roots` (including the symlink cases), `diag_logs_boundary`,
   `collect_boundary`, plus `service_name_boundary` — assert **all three** copies of `SERVICE_RE`
   agree (`runner_scan.ts`, `runner_env.ts`, and `prod-scripts/ci-panel-runner-svc`; the bash one
   is the real boundary, being the one that runs as root) and that the shape rejects whitespace,
   `/` and option-shaped names
4. Write `token_redaction.spec.ts` against `redactTokenArgs` (§7.2)
5. Add `Test daemon` + `Type-check daemon` to CI

**Exit criteria:** every §2.3 case passes including the three symlink ones; `ProvisionError.fullLog`
provably redacts the token; `tsc --noEmit -p tsconfig.test.json` clean.

> **Corrections to §2.3, found by writing the specs.** The table described intended behaviour in
> two places where the code did something else. Both fixed in the same PR.
>
> 1. *"a child of `base` is a symlink outside the roots → skipped with a reason"* — `collectRunnerDirs`
>    guarded only the root it was handed; the recursive descent had no check at all. Since
>    `statSync` / `readdirSync` / `isRunnerDir` all follow links, one `<root>/<repo>/x -> /anywhere`
>    made the scan read that directory's `.runner` and report it as a normal runner, `errors` empty.
>    The guard now runs per level and records the skip.
> 2. **Directory-level guarding is not enough, which the table did not consider at all.** The three
>    metadata files (`.runner`, `.service`, `.cipanel`) are writable by the runner's own account and
>    `readFileSync` follows links, so a directory legitimately inside the roots could still serve up
>    any file on the host. `.runner -> <secret>` put its `gitHubUrl`/`agentName` straight into the
>    list; when the target was not JSON, Node's parse error embedded the first ~10 bytes of content
>    and shipped them to the UI as `broken`; and `.cipanel -> <anywhere>` made `hasMarker` true,
>    which is what `registerRunners` and `scanOneRunner` use to *skip* `assertUnderRoots` entirely.
>    New `metaFilePath` in `runner_marker.ts` requires each metadata file to resolve inside its own
>    directory. Deliberately not an `assertUnderRoots` call: managed runners are allowed to live
>    outside the roots, so "must not escape its own directory" is the constraint that holds for both.
>
> Also note `collectFromRoots` **collects** the root rejection into `errors` rather than throwing,
> so the `collectRunners("/etc") → throws` row is really "returns no runners and one error".

### Phase 3 — contract layer (2–3 days)

1. `common/test/contract/i18n_keys.spec.ts` — calibrated against the real catalogues: all 11
   non-source languages have 0 extra keys (green today); completeness gated on zh_CN only,
   placeholders on zh_CN + zh_TW
2. Record the 7 untranslated ci-panel keys (`TXT_CODE_REPO_AUTO_REGISTER_*`,
   `TXT_CODE_RUNNER_IMPORT_OK*`) as a known gap rather than blocking the pipeline; widen the gate
   once they are translated
3. `common/test/contract/runner_protocol.spec.ts` — replay the **unchecked cast** panel performs at
   `runner_router.ts:354-360` and pin every field
4. Delete the duplicate `RunnerSource` in `daemon/src/service/runner_marker.ts:23`; import the one
   from `common/src/runner_protocol.ts`
5. Extract the frontend `labelKey` into `frontend/src/tools/runnerNaming.ts`, replace the copy in
   `AddRunnerDialog.vue:84`, and assert it agrees with the daemon's (`runner_provision.ts:498`) —
   divergence produces fleet-wide runner-name collisions

### Phase 4 — panel authorization and remaining boundaries (4–5 days)

0. In `panel/`: `npm i -D vitest@^0.34.6 @vitest/coverage-v8@^0.34.6` (pin 0.34.x — TS 4.9.5, Node 14 typings)
1. `panel/vitest.config.ts` **must set `threads: false`**: `common/src/system_storage.ts:5` computes
   `DATA_PATH` from `process.cwd()` at class-definition time, so the store can only be redirected by
   `process.chdir` in a setup file — and that throws inside worker threads. Also clear
   `CIP_GITHUB_REPOS` / `CIP_GITHUB_TOKEN` via `test.env`, so `repo_service.ts`'s import-time
   `migrateFromEnv()` cannot pick up the developer's shell
2. Specs: `permission_middleware` (per branch), `api_key_auth`, `token_never_leaks`
3. Fix `panel/src/app/utils/url.ts` — the `ipv4Regex` early return makes the private-range checks
   below it dead code; then wire `checkSafeUrl` into `/api/auth/proxy`
   (`login_router.ts:133-149`), which calls `axios.request` on an operator-supplied target today
   with no host validation
4. Fix `daemon/src/service/disk_limit_service.ts:107` — `du -s --block-size=1M "${workspace}"` runs
   through `promisify(exec)`; switch to the argv form of `execFile`
5. `daemon/test/security/file_manager_paths.spec.ts`, including a case that **documents current
   behaviour**: `FileManager.isRootTopRath()` short-circuits every guard, and
   `system_instance.ts:116` sets the built-in global instance's cwd to `/`
6. Add `Test panel` + `Type-check panel` to CI

### Phase 5 — router integration and pure-logic breadth (5–7 days, **cuttable**)

1. Split `daemon/src/service/router.ts`: move `RouterApp` + `routerApp` + `navigation` into a new
   `router_app.ts`, keeping the re-exports and ten side-effect imports so `app.ts:15` is untouched
2. Make `emitRouter` (`router.ts:16`) await-aware — it currently wraps `super.emit` in a synchronous
   try/catch, so **an async handler that rejects emits nothing** and the panel's request hangs
3. Export the private parsers in `runner_env.ts` / `runner_provision.ts` / `runner_scan.ts` (no
   behaviour change) and add pure-logic specs
4. Upload coverage as an artifact — **still no thresholds**

**Stopping rule:** Phase 4 is the line. After it, a new spec is added only when a bug reaches
master (failing test first, then the fix). The Phase 5 refactors are unlocked by a specific escaped
bug, not scheduled.

## 6. New config files

Full contents of every file still to create — `common/vitest.config.ts`,
`daemon/vitest.config.mts` (and panel's), `daemon/test/setup.ts`, the two
`tsconfig.test.json`, and the `package.json` script additions — are in
[TESTING_SETUP.md](TESTING_SETUP.md). frontend's are already in the tree
([vitest.config.ts](frontend/vitest.config.ts), [vitest.setup.ts](frontend/vitest.setup.ts)) and
were removed from that file. Delete it entirely once the other three land; neither document should
carry a second copy of a checked-in config.

## 7. Minimum refactors

Only what is required to unlock high-value tests. None change behaviour.

### 7.1 No barrel imports (the two `unref` calls landed in #24)

`require('common/dist/index.js')` used to leave an active `Timeout` and **never exit** (exit 124):
`common/src/index.ts` re-exports `system_info`, which started an un-unref'd `setInterval`.
Both that timer and `daemon/src/service/log.ts`'s are `.unref()`'d as of #24. The import rule still
stands regardless: specs in `common/` import the specific module, **never the barrel** — the barrel
drags in every consumer's side effects for no benefit.

### 7.2 `redactTokenArgs` (daemon) — extracted in #24

The redaction in `runner_provision.ts` was inline, and testing inline logic means restating the
implementation in the spec, which **cannot detect a bug in it**. It is now a real symbol:

```ts
export function redactTokenArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === "--token" ? "***" : a));
}
```

It matches by argument *position*, so renaming `--token` would silently stop redacting — that is
what `token_redaction.spec.ts` (Phase 2) pins. Specs use placeholder tokens and
`example-org/example-repo` only — **this is a public repository**.

### 7.3 Add `export` (daemon, no behaviour change)

`runner_env.ts`: `parseEnvironmentLine`, `parseOverrideConf`, `parseDotEnv`, `sanitizeVars`,
`resolveDesired`. `runner_provision.ts`: `parseRunnerVersion`, `cmpVersion`, `clampConcurrency`.
`runner_scan.ts`: `isSettled`, `parseRoots`, `repoSlug`. Needed only for Phase 5.

## 8. CI

The **second job** — `test:` in [.github/workflows/ci.yml](.github/workflows/ci.yml) — landed with
Phase 0. As of Phase 2 it runs `Build common`, `Test common`, `Test daemon`, `Test frontend` and
`Type-check daemon (incl. tests)`; the remaining steps below arrive with the phase that gives their
package a suite. The existing `build:` job stays
byte-identical: it is the current release gate and must not be slowed or destabilised by
test-install variance.

Its first three steps (`actions/checkout@v4`, `actions/setup-node@v4` with its five-line
`cache-dependency-path`, and `Install dependencies: npm install`) are **byte-identical to the
`build:` job**. The root `npm install` lifecycle script chains install-dependents and preview-build,
so that one command provisions every package's devDependencies including vitest.

The block below is the **target state** once every phase has landed — add each step in the phase
that gives its package a suite, never ahead of it:

```yaml
      - name: Build common          # guard for the day the preview-build hook goes away
        run: npm run build --prefix common

      # `timeout` is load-bearing here, not redundant: reverting the pagination guard hangs the
      # worker synchronously, where vitest's own testTimeout never even gets scheduled (§2.2).
      - name: Test common           # carries the formerly-exploitable defects; fails fastest
        run: timeout -k 10 120 npm run test --prefix common

      - name: Test daemon
        run: npm run test --prefix daemon

      - name: Test panel
        run: npm run test --prefix panel

      - name: Test frontend
        run: npm run test --prefix frontend

      # panel/daemon tsconfig include does not cover test/, so webpack never sees a spec.
      - name: Type-check daemon (incl. tests)
        run: npm run type-check --prefix daemon

      - name: Type-check panel (incl. tests)
        run: npm run type-check --prefix panel

      - name: Upload coverage
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: |
            common/coverage/lcov.info
            daemon/coverage/lcov.info
            panel/coverage/lcov.info
            frontend/coverage/lcov.info
          if-no-files-found: ignore
```

Two prerequisites. **Add the steps one phase at a time** — a `Test <pkg>` step must not land before
that package has a suite. And `passWithNoTests: true` is a temporary crutch: a config needs it only
in the window between adding the package's `test` script and writing its first spec (an empty suite
exits 1). **Drop it in the same commit as the first spec** — kept afterwards, it turns a broken
`include` glob into a green job that ran nothing. frontend's config does not have it.

**`release.yml` needs no change.** Its gate is `pack.sh` + `smoke-test.sh` + Playwright. Unit tests
belong on the PR path; the tag path would only get slower, and `release.yml` holds `contents: write`,
so its dependency surface should stay narrow.

## 9. Coverage and gating

| | Initially | After Phase 4 |
| --- | --- | --- |
| Coverage threshold | **none** — lcov uploaded as an artifact only | line coverage ≥60% on `common/src` and `daemon/src/service/runner_*` |
| Blocks merge | security-regression layer + all `type-check` | same, plus the contract layer |
| Blocks release (`release.yml`) | no | no |
| Suite runtime budget | — | < 3 min on ubuntu-latest |

**Why no threshold at first:** a risk-first order puts ~130 cases in about 15 files across the first
four phases, leaving `frontend/` (33.6K lines) almost untouched. Any threshold would either fail at
once or be meaningless, and ratcheting early pushes effort toward easily-covered formatters.

**Every package sets `threads: false`.** Not a preference — tinypool sizes its worker pool from the
CPU count, and these suites are a handful of files whose assertions run in milliseconds, so the
entire wall time is worker startup. Measured on a 320-core machine:

| Package | default | `threads: false` |
| --- | --- | --- |
| `common` (2 files, 34 cases) | 106s | **1.1s** |
| `frontend` (3 files, 41 cases) | 84s | **3.6s** |

On GitHub's 4-core `ubuntu-latest` the default is survivable (frontend measured 56s), but this
project provisions self-hosted runners — the day the `test` job moves onto a big one, `Test common`
blows through its `timeout -k 10 120` and dies with **exit 124, the same code the infinite-loop
regression produces**. A green suite failing indistinguishably from the defect the watchdog exists
to catch is the worst possible failure mode, and one line prevents it.

The cost is a shared process: module-level singletons persist across spec files. Nothing relies on
per-file module isolation today; do not start.

## 10. Trade-offs, and what we deliberately skip

- **Testing the daemon means importing the daemon.** `runner_scan.ts` / `runner_provision.ts`
  transitively import the `InstanceSubsystem` singleton, whose constructor does `fs.mkdirsSync`.
  The `test/setup.ts` chdir and the `.unref()` calls **contain** that rather than remove it; the real
  fix (narrow `HandleInstanceStore` / `runner_exec` ports) is deferred to Phase 5, being bigger than
  the security tests it would unlock.
- **Aliasing to source is a deliberate asymmetry.** daemon and panel test `common/src` while the
  frontend build consumes `common/dist`. A change that breaks the built output but not the source
  would pass the daemon suite — the `Build common` CI step exists for exactly that.
- **The i18n gate is narrower than it looks.** Every language except zh_CN is missing the same 7
  keys, and 9 of 12 have placeholder mismatches (ru_RU 18, pt_BR 17, es_ES 15). Completeness and
  placeholders are therefore scoped to zh_CN / zh_TW — better a weak gate that is green from the
  first commit than a strong one that goes red and gets ignored.
- **Router integration is the likeliest casualty** (it needs the `router_app.ts` split and an
  await-aware `emitRouter`, both touching ten router files). Cutting it leaves the daemon's worst
  defect — an async handler rejection emits nothing and hangs the panel's request — uncovered.

| Skipped | Why |
| --- | --- |
| E2E / browser tests | `scripts/release/smoke-test.sh` + `browser-check.mjs` already boot the stack and run Playwright on the release path. The risks this plan targets — path traversal, token leakage, protocol drift — are caught more deterministically at the unit and contract layers |
| Broad Vue component mounting | Most of the 205 files are presentational; xterm / monaco / echarts / codemirror need heavy stubs for very little return. Test the extracted pure functions instead |
| Pure-function specs for panel | Its only pure function, `checkSafeUrl` (`utils/url.ts:5`), currently has **zero callers**. panel's real logic is Koa-middleware shaped — test the middleware |
| Lint gate / snapshot tests | The former needs a dependency migration (both eslint setups are broken); the latter produces "changed, so update it" ritual and catches none of the risks here |

## 11. How to verify the setup itself

Run each of these rather than assuming.

1. **Build and type-check each package** (note the directory): `common/` → `npm run build` (it has
   no `type-check`); `daemon/` → `npm run type-check && npm run build`; `panel/` → `npm run build`
   only, until Phase 4 gives it a `tsconfig.test.json`; `frontend/` → `npm run type-check &&
   npm run lint`.
2. **Prove the loop:** in each package, first write an assertion that must fail and confirm it
   **does**, then correct it. A test that passes against broken code tests nothing.
3. **Handle leaks:** `cd daemon && npx vitest run --reporter=verbose` and confirm the process exits
   on its own. If it hangs, some `setInterval` is missing `.unref()` (§7.1).
4. **Sandbox:** after the daemon suite, `git status` must be clean. A `logs/` or `data/` directory
   means the `test/setup.ts` chdir did not take effect.
5. **Reverting a 1.0.4 fix must turn a spec red** — the only real proof the §2 specs work. Check
   once per spec, then restore.
6. **i18n:** confirm new `TXT_CODE_*` keys resolve in the UI rather than rendering as raw keys.
