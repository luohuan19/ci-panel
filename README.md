# ci-panel

A web panel for managing **GitHub Actions self-hosted runners** across multiple
machines.

ci-panel is a fork of [MCSManager](https://github.com/MCSManager/MCSManager). It
keeps the upstream panel/daemon architecture — a central web backend talking to
one daemon per machine over a WebSocket — and replaces the game-server features
with runner management.

## Features

- **Runner inventory** — scan each node for self-hosted runners (panel-created and
  systemd-managed alike), grouped by repository
- **One-click provisioning** — register, activate, deactivate and remove runners,
  in single or batch mode, from the built-in runner package or an imported tarball
- **Runner environment** — panel-managed environment variables per runner
- **Live logs** — stream a runner's diagnostic logs and job output in the browser
- **CI job board** — recent workflow runs across the registered repositories
- **File manager and web terminal** — per-runner working directory access
- **Distributed** — one panel, many nodes; multi-user with granular permissions
- **Node metrics** — rolling per-node CPU and memory usage

## Packages

Four packages, **not** an npm workspace — each installs and builds separately.

| Package     | Role                                                             |
| ----------- | ---------------------------------------------------------------- |
| `panel/`    | Web backend — users, auth, node connections, HTTP API            |
| `daemon/`   | Node daemon — runner scan/provision/logs, instances, files, Docker |
| `frontend/` | Vue 3 UI                                                         |
| `common/`   | Shared types, consumed by the other three                        |

For how the pieces fit together, see [ARCHITECTURE.md](ARCHITECTURE.md)
([中文](ARCHITECTURE_ZH.md)).

## Runtime environment

Runs on Linux and Windows; no database required.

> Requires **[Node.js 16.20.2](https://nodejs.org/en)** or higher. The latest LTS
> release is recommended.

The daemon needs two binary helpers from upstream — `pty` and the zip tools — in
`daemon/lib/`. See `lib-urls.txt` for the download URLs, or run
`install-dependents.sh` (Linux/macOS) / `install-dependents.bat` (Windows).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) ([中文](DEVELOPMENT_ZH.md)).

## Deployment

`prod-scripts/` holds the production install and service scripts, including the
runner privilege setup required at deploy time — see
[prod-scripts/README.md](prod-scripts/README.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

Apache-2.0. Copyright 2025 MCSManager, and contributors to this fork. See
[LICENSE](LICENSE).
