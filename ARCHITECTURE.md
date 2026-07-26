# ci-panel Architecture

A web panel for managing **GitHub Actions self-hosted runners** across many machines.

ci-panel is a fork of [MCSManager](https://github.com/MCSManager/MCSManager). It keeps
the upstream panel/daemon topology — one central web backend talking to one daemon per
machine over a persistent Socket.IO connection — and replaces the game-server domain
with runner management. The Minecraft/game-server feature set was removed in full; see
[Fork divergence](#fork-divergence).

> Chinese version: [ARCHITECTURE_ZH.md](ARCHITECTURE_ZH.md)

## Contents

- [Topology](#topology)
- [Packages](#packages)
- [Panel](#panel)
- [Daemon](#daemon)
- [Panel ↔ daemon protocol](#panel--daemon-protocol)
- [Frontend](#frontend)
- [Common](#common)
- [Runner management](#runner-management)
- [Repo registry and CI board](#repo-registry-and-ci-board)
- [Data on disk](#data-on-disk)
- [Build and deployment](#build-and-deployment)
- [Internationalisation](#internationalisation)
- [Fork divergence](#fork-divergence)

## Topology

```text
                 browser
                    │  HTTP + Socket.IO   (default :23333, data port :23334)
                    ▼
   ┌────────────────────────────────┐
   │  panel  (Koa, mcsmanager-panel)│   users · auth · permissions · HTTP API
   │  data/  User RemoteServiceConfig│  SystemConfig RepoConfig operation_logs
   └───────────────┬────────────────┘
                   │ Socket.IO client, one per node, authenticated by a shared key
      ┌────────────┼────────────┐
      ▼            ▼            ▼
 ┌─────────┐  ┌─────────┐  ┌─────────┐
 │ daemon  │  │ daemon  │  │ daemon  │   node-local: filesystem, systemd, Docker
 │  :24444 │  │         │  │         │
 └────┬────┘  └─────────┘  └─────────┘
      │ scans / provisions / reads
      ▼
  actions-runner directories on disk
  <dir>/.runner  .service  .cipanel  _diag/
      │ managed by
      ▼
  systemd units  actions.runner.<owner>-<repo>.<name>.service
```

The panel never touches a runner directly. Everything node-local — filesystem access,
`systemctl`, Docker, process spawning — happens in the daemon, and the panel reaches it
by emitting a named event over the socket.

## Packages

Four packages, **not** an npm workspace. Each has its own `node_modules` and is
installed and built separately. `common/` must be rebuilt before the other three see
type changes.

| Package     | npm name            | Role |
| ----------- | ------------------- | ---- |
| `panel/`    | `mcsmanager-panel`  | Web backend: users, auth, node connections, HTTP API |
| `daemon/`   | `mcsmanager-daemon` | Node agent: runner scan/provision/logs, instances, files, Docker |
| `frontend/` | `mcsmanager-ui`     | Vue 3 SPA (`<script setup lang="ts">`) |
| `common/`   | `mcsmanager-common` | Shared types and utilities, consumed by the other three |

The npm package names are inherited from upstream and deliberately unchanged —
`mcsmanager-common` is imported by name from `panel/` and `daemon/`.

```bash
npm run install-dependents   # install panel + daemon + frontend
npm run preview-build        # build common/ (do this before the others)
npm run dev                  # run all three concurrently
./build.sh                   # production bundle -> production-code/
```

Dev servers: frontend on Vite's `:5173`, proxying `/api` to the panel on `:23333`.

## Panel

Koa application. Entry `panel/src/app.ts`, routers mounted in `panel/src/app/index.ts`
under the `/api` prefix.

### HTTP API surface

| Router file | Prefix | Covers |
| ----------- | ------ | ------ |
| `runner_router.ts` | `/api/runner` | Runner scan, provision, register/unregister, batch ops, env vars, service control, diag logs, directory picker |
| `repo_router.ts` | `/api/repo` | Repository registry: list, add, update, delete |
| `ci_router.ts` | `/api/ci` | CI job board — proxies the GitHub Actions API |
| `daemon_router.ts` | `/api/service` | Node (daemon) connection management |
| `instance_admin_router.ts` | `/api/instance` | Instance CRUD, multi-instance operations |
| `instance_operate_router.ts` | `/api/protected_instance` | Per-instance start/stop/kill/command, terminal stream channel, config update |
| `filemananger_router.ts` | `/api/files` | File manager proxy |
| `environment_router.ts` | `/api/environment` | Docker images, containers, networks |
| `schedule_router.ts` | `/api/protected_schedule` | Scheduled tasks |
| `login_router.ts`, `general_user_router.ts`, `manage_user_router.ts`, `user_overview_router.ts` | `/api/auth` | Login, session, API key, user management |
| `sso_router.ts` | `/api/auth/sso` | OIDC / OAuth 2.0 single sign-on |
| `overview_router.ts`, `settings_router.ts` | `/api/overview` | Dashboard data and system settings |

### Services

| Service | Responsibility |
| ------- | -------------- |
| `remote_service.ts` | Owns the Socket.IO client per node; connection lifecycle and availability |
| `remote_command.ts` | `RemoteRequest` — request/response over the socket with a UUID and timeout |
| `repo_service.ts` | Repository registry, and fan-out of `runner/scan` across nodes |
| `user_service.ts`, `passport_service.ts`, `permission_service.ts` | Users, sessions, API keys, per-instance authorisation |
| `sso_service.ts`, `user_sso_service.ts` | SSO providers and account binding |
| `frontend_layout.ts` | Serves and persists the frontend's card-layout config |
| `operation_logger.ts` | Append-only audit log (JSONL) |
| `visual_data.ts` | Request/instance counters for the dashboard charts |
| `instance_service.ts` | Instance list assembly, multi-node forwarding |
| `version_adapter.ts` | On-disk config migrations between versions |

### Auth and permissions

`ROLE` is `ADMIN = 10`, `USER = 1`, `GUEST = 0`, `BAN = -1`
(`panel/src/app/entity/user.ts`). Routes declare a minimum level via the `permission`
middleware; instance-scoped routes additionally check ownership through
`permission_service`. Sessions are cookie-based, with an alternative API-key header for
programmatic access, 2FA (TOTP), and optional SSO. `middleware/limit.ts` applies rate
limits, `middleware/validator.ts` validates query and body shapes at the boundary.

## Daemon

Socket.IO **server** (default `:24444`). It does not dial out; the panel connects to it.
Entry `daemon/src/app.ts`; routers register event handlers on a shared `routerApp`
emitter (`daemon/src/service/router.ts`).

### Event surface

| Router file | Events |
| ----------- | ------ |
| `runner_router.ts` | `runner/scan` `managed_list` `register` `unregister` `delete` `provision` `provision_batch` `batch_start` `batch_progress` `batch_retry` `check` `collect` `repo_groups` `state` `service_control` `env_get` `env_set` `diag_logs` `list_dirs` `mkdir` `download_start` `download_progress` |
| `Instance_router.ts` | `instance/select` `overview` `section` `detail` `new` `update` `open` `stop` `restart` `kill` `command` `delete` `forward` `asynchronous` `stop_asynchronous` `outputlog` |
| `file_router.ts` | `file/list` `chmod` `chmod_batch` `status` `touch` `mkdir` `copy` `move` `delete` `edit` `compress` `download_from_url` `download_from_url_stop` |
| `environment_router.ts` | `environment/images` `containers` `networkModes` `new_image` `del_image` `progress` `image_platforms` |
| `stream_router.ts` | `stream/auth` `detail` `input` `write` `resize` |
| `schedule_router.ts` | `schedule/register` `list` `delete` |
| `auth_router.ts`, `passport_router.ts`, `info_router.ts` | `auth`, `passport/register`, `info/overview`, `info/setting` |

### Services

Runner-specific services are described under [Runner management](#runner-management).
The rest are inherited process/container plumbing:

| Service | Responsibility |
| ------- | -------------- |
| `system_instance.ts` | The instance registry; load, create, delete, forward I/O |
| `docker_process_service.ts` | `SetupDockerContainer` — builds the container spec (ports, volumes, cgroup limits, GPU device passthrough) and attaches to it |
| `system_file.ts` | Sandboxed filesystem access rooted at an instance's cwd |
| `download_manager.ts`, `upload_manager.ts` | File transfer tasks |
| `network_limit_service.ts`, `disk_limit_service.ts` | Per-container traffic and disk quotas |
| `system_visual_data.ts` | Rolling 200-point CPU% / memory% series for the node |
| `async_task_service/` | Base class for long-running tasks (`AsyncTask`) |

### Instances and commands

An **instance** is the daemon's unit of process management. `FunctionDispatcher`
(`entity/commands/dispatcher.ts`) wires a set of preset commands onto each instance
based on its config:

| Preset | Implementation |
| ------ | -------------- |
| `start` | `GeneralStartCommand`, or `PtyStartCommand` when the emulated terminal is on, or `DockerStartCommand` in Docker mode |
| `stop` / `kill` / `restart` / `update` / `command` | `general/*` commands |
| `resize` | `PtyResizeCommand` / `DockerResizeCommand` |

Lifecycle tasks (`TimeCheck`, `InstanceDiskCheckTask`, `DockerStatsTask`) are registered
alongside. In this fork most instances are **handle instances** — see below.

## Panel ↔ daemon protocol

- Transport: Socket.IO. The panel is the client, the daemon is the server.
- Authentication: the daemon generates a `key` in its config; the panel stores it per
  node and sends it in the `auth` event. Everything except `auth` and the `stream/*`
  channel requires an authenticated session. The key comparison is constant-time.
- Request/response: `RemoteRequest.request(event, data, timeout)` attaches a UUID to the
  packet and resolves when a packet with the same UUID comes back
  (`{ uuid, data, status }`). Default timeout 6 s.
- Push: the daemon emits `instance/stdout`, `instance/stopped`, `instance/opened`,
  `instance/failure` for live terminal output and state changes.
- Terminal data channel: `stream/*` is a separate authorisation path. The panel issues a
  one-time password via `passport/register`, the browser opens its own connection to the
  daemon with it, and terminal I/O bypasses the panel.

## Frontend

Vue 3 + TypeScript + Vite, Ant Design Vue, Pinia, `vue-i18n`, xterm.js, ECharts.

### Layout card system

Most pages are not hand-written. A page is a list of **cards** resolved at runtime:

1. `panel/src/app/service/frontend_layout.ts` serves the layout config — either the
   user's saved `layout.json` or the built-in default — as a list of pages, each holding
   card entries `{ id, type, title, width, height, meta }`.
2. `LayoutContainer.vue` looks up the entries for the current route.
3. `LayoutCard.vue` maps `card.type` to a component through `LAYOUT_CARD_TYPES`
   (`frontend/src/config/index.ts`) and renders it.

`type` is a plain string, so **no static check validates it**. If a saved layout names a
card type that no longer exists, `LayoutCard.vue` renders `CardError` with the offending
name rather than a blank slot.

Two pages deliberately bypass the card system and are ordinary routed components:
`/ci` (`CiJobs.vue`) and `/instances/runner` (`RunnerDetail.vue`, lazily imported to
avoid a circular-import initialisation order problem).

### Layout

| Path | Contents |
| ---- | -------- |
| `views/` | Route-level shells: `LayoutContainer`, `Login`, `Install`, `SsoBindLogin` |
| `widgets/` | Card components: `RunnerExplorer`, `RunnerDetail`, `RunnerLogView`, `CiJobs`, `NodeList`, `UserList`, `Settings`, `instance/*` … |
| `components/` | Reusable UI. **Everything here is auto-registered globally** by `unplugin-vue-components`, so it can be used as `<kebab-case-tag>` with no import |
| `hooks/` | Composables: `useInstance`, `useTerminal`, `useFileManager`, `useRemoteNode`, `useCardTools` … |
| `services/apis/` | Typed API clients built on `useDefineApi` |
| `stores/` | Pinia stores: app state, app config, layout config, card pool |
| `config/` | `router.ts` (routes), `index.ts` (card registry + card pool) |

### Runner UI

| Component | Role |
| --------- | ---- |
| `RunnerExplorer.vue` | Main `/instances` page: runners grouped by repository, batch selection and operations |
| `AddRunnerDialog.vue` | Provision runners — single or batch, with labels and proxy |
| `ImportRunnerDialog.vue` | Full-disk scan, then adopt pre-existing runners |
| `RunnerDetail.vue` | `/instances/runner`: live state, env vars, embedded file manager, delete flow |
| `RunnerLogView.vue` | Follows `_diag` logs incrementally |
| `CiJobs.vue` | `/ci`: recent workflow runs per repository |

## Common

Built with `tsc` to `common/dist`, consumed by name. Exports: `StorageSubsystem`
(JSON-file persistence), `GlobalVariable`, `InstanceStreamListener`, `ProcessWrapper` /
`killProcess`, `QueryWrapper` / `QueryMapWrapper` / `LocalFileSource` (paged querying),
`systemInfo`, Docker platform normalisation, and type-coercion helpers
(`toText`, `toNumber`, `toBoolean`, `isEmpty`, `configureEntityParams`).

`common/global.d.ts` declares the ambient interfaces shared across packages, notably
`IGlobalInstanceConfig` and `IGlobalInstanceDockerConfig`.

## Runner management

This is the domain the fork exists for. The design rests on one decision:

> **The filesystem is the source of truth, not a panel-side database.**

### Marker files

Each runner directory carries three files, each recording one thing and never
overwriting the others:

| File | Written by | Records |
| ---- | ---------- | ------- |
| `.runner` | the official GitHub runner, at registration | ownership — `gitHubUrl`, `agentName` |
| `.service` | `svc.sh`, at unit installation | the systemd unit name |
| `.cipanel` | ci-panel (`runner_marker.ts`) | that this runner is panel-managed, and whether it arrived by `provision` or `import` |

`.cipanel` is the **only** source of truth for membership. The panel keeps no second
registry to reconcile against, which is what stops the two from drifting apart.

### Services

| Service | Responsibility |
| ------- | -------------- |
| `runner_scan.ts` | Walks the whitelisted roots and reports what is really on disk. `scanManagedRunners` (has `.cipanel`) drives normal display; `scanRunners` (everything) is only for the import flow. Uses async `execFile` because it runs every ~10 s and a synchronous `systemctl` can stall the daemon's event loop long enough to drop the WebSocket heartbeat |
| `runner_provision.ts` | Unpack package → `config.sh` register with GitHub → install and start the systemd unit → create the handle instance |
| `runner_marker.ts` | Read/write `.cipanel` (v2 format, adds `labels`) |
| `runner_env.ts` | Two environment-variable targets with different semantics — see below |
| `runner_logs.ts` | Incremental tail of `_diag/Runner_*.log` and `Worker_*.log`, capped at 512 KB per read |

### Hosting model

**systemd only.** A provisioned runner is started by its own systemd unit, so it
survives reboots and daemon restarts, and `managedBy` is only ever `systemd` or `none`.

The panel-side instance is a **handle instance**: it carries no start command and never
runs the runner. It exists so that the file manager, config and detail pages — all of
which authorise by `instanceUuid` and root themselves at the instance cwd — have
something to attach to. An earlier design had the daemon supervise `run.sh` as a child
process; it was dropped because two supervisors would fight over one GitHub identity.

### Privileged operations

The daemon runs as a non-root user (`ci-runner`) and escalates through exactly one
script, `prod-scripts/ci-panel-runner-svc`, invoked with `sudo -n`:

- the script is root-owned and not writable by `ci-runner`;
- it only writes units it generates itself into `/etc/systemd/system`, and never
  executes scripts from the runner directory (which `ci-runner` *can* write);
- the generated unit runs `runsvc.sh` as `User=<directory owner>`, so the runner itself
  stays unprivileged;
- the target directory must sit under a whitelisted root and contain `.runner`, and the
  unit name must match `^actions\.runner\.[A-Za-z0-9._@-]+\.service$`.

`install-runner-privileges.sh` installs the script and its sudoers entry; the helper
carries a `VERSION` so deployment can detect a stale copy via `preflight`.

### Environment variables

Two targets, because `runsvc.sh` on these machines does not source `.env`:

| Target | Location | Reaches | Privilege |
| ------ | -------- | ------- | --------- |
| `override` | systemd drop-in `/etc/systemd/system/<unit>.d/override.conf` | the listener process — proxies and anything `Runner.Listener` needs to reach GitHub | root, via the helper |
| `dotenv` | `<runner dir>/.env` | job/step execution only, read by the runner program | none — the file is owned by the daemon user |

Both are managed as a whole table: read back, edit, overwrite. Variable names are
whitelisted (`^[A-Za-z_][A-Za-z0-9_]*$`) and values may not contain newlines.

## Repo registry and CI board

`panel/data/RepoConfig/<owner@repo>.json` records which repositories are managed, plus
an optional PAT and remark. It deliberately does **not** store which runners belong to a
repository — that is answered by scanning each node, because most runners on a machine
are systemd-managed and absent from any instance table.

The CI board (`/api/ci`) reads workflow runs from the GitHub Actions API using the
per-repository PAT, falling back to the `CIP_GITHUB_TOKEN` environment variable. A PAT
is optional for public repositories (60 req/h anonymous, 5000 with a token) and required
for private ones.

## Data on disk

| Path | Contents |
| ---- | -------- |
| `panel/data/User/` | User records |
| `panel/data/RemoteServiceConfig/` | Node connection configs (address, key, remarks) |
| `panel/data/SystemConfig/` | Panel settings |
| `panel/data/RepoConfig/` | Repository registry |
| `panel/data/operation_logs/` | JSONL audit log |
| `panel/data/layout.json` | Saved card layout (absent until customised) |
| `daemon/data/Config/` | Daemon config, including the auth key |
| `daemon/data/InstanceConfig/` | Instance configs |
| `daemon/data/InstanceData/` | Instance working directories |
| `daemon/data/InstanceLog/` | Terminal logs |
| `daemon/data/TaskConfig/` | Scheduled tasks |
| `daemon/data/runner-pkg/` | actions-runner tarballs (override with `CIP_RUNNER_PKG`) |

Persistence is plain JSON files through `StorageSubsystem`; there is no database. Redis
is available as an optional session/cache backend only.

### Environment variables

| Variable | Read by | Purpose |
| -------- | ------- | ------- |
| `CIP_RUNNER_PKG` | daemon | Path to the actions-runner tarball |
| `CIP_RUNNER_PROXY` | daemon | Fallback proxy for runner registration |
| `CIP_GITHUB_TOKEN` | panel | Fallback PAT for the CI board |
| `CHOKIDAR_USEPOLLING` | frontend dev | Poll instead of inotify on hosts with a low watch limit |

## Build and deployment

`./build.sh` (or `build.bat`) builds `common` → `daemon` → `panel` → `frontend` and
collects the result into `production-code/`:

```text
production-code/
├── daemon/app.js          + package.json, package-lock.json
└── web/app.js             + package.json, package-lock.json
    └── public/            the built frontend
```

The daemon additionally needs two binary helpers from upstream in `daemon/lib/` — `pty`
and the zip tools. `lib-urls.txt` lists the download URLs; `install-dependents.sh` /
`.bat` fetch them. `checkDependencies()` fails fast at startup if they are missing.

`prod-scripts/` holds the production install and service scripts, including the runner
privilege setup that must run at deploy time; see `prod-scripts/README.md`.
`dockerfile/` builds container images for the panel and daemon.

## Internationalisation

Twelve locales live in `languages/*.json` as flat `TXT_CODE_*` maps, statically imported
by all three runtime packages. Frontend uses `t()` with single braces; the backends use
`$t()` with double braces. All twelve files carry an identical key set, so no locale can
fall back to a key another locale lacks.

`npm run i18n` scans for new keys; `npm run scan-useless-key` reports unreferenced ones.

## Fork divergence

Removed from upstream MCSManager, and not coming back:

- Minecraft and game-server support: server ping (Java + Bedrock), player counts, Steam
  RCON, SteamCMD, MCDR, the mod manager, the Java runtime manager, the
  `server.properties`/yml/toml config editor, and all `minecraft/*`, `steam/*` and
  `hytale` instance types
- The application market and its quick-install task
- Commercial/redeem mode and the Pro-panel iframe bridge
- The anonymous usage ping to upstream

Kept on purpose: the Apache-2.0 licence and upstream copyright notices; the persisted
identifiers `__MCSM_GLOBAL_INSTANCE__`, the `{mcsm_*}` command placeholders and the
`mcsmanager.instance.uuid` Docker label; the `mcsmanager-*` npm package names; and the
PTY / Zip-Tools download URLs.

The instance, terminal, file manager, scheduler and Docker subsystems all remain — the
runner features are built on top of them.
