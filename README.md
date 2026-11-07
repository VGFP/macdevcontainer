# macdevcontainer

[![CI](https://github.com/VGFP/macdevcontainer/actions/workflows/ci.yml/badge.svg)](https://github.com/VGFP/macdevcontainer/actions/workflows/ci.yml)

**Use Apple's native `container` runtime as a Dev Containers backend in VS Code — no Docker Desktop.**

> **Status: early development.** The extension is being built from scratch. Interfaces, file names and behaviour may change.
>
> Not affiliated with Apple Inc. or Microsoft.

---

## Why this exists

Apple's [`container`](https://github.com/apple/container) runs Linux containers in lightweight virtual machines on Apple Silicon — no Docker daemon, no Docker Desktop licence, native macOS virtualisation.

Microsoft's **Dev Containers** extension, however, only talks to a Docker- or Podman-compatible CLI/API. Apple `container` provides neither, so `.devcontainer/devcontainer.json` projects cannot use it directly.

`macdevcontainer` bridges that gap:

- drives the `container` CLI directly (no Docker socket),
- creates the dev container from `devcontainer.json`,
- opens VS Code through **Remote - SSH** into the container,
- forwards application ports over SSH — **not** through Apple's `--publish`, which is unreliable on current macOS builds.

---

## How it works

1. Read `.devcontainer/devcontainer.json` (a supported subset — see [Configuration](#configuration)).
2. Build the image with `container build`, or pull it with `container image pull`.
3. Create and start a container with the workspace bind-mounted.
4. Inject a per-project SSH key and ensure `sshd` is running inside the container (installing `openssh-server` automatically if needed).
5. Open a new VS Code window using Remote - SSH, connecting to the container's **direct IP** (`192.168.64.x`) rather than a published host port.
6. Forward `forwardPorts` through the SSH connection.

Using the container IP sidesteps the broken `container run -p` path on macOS 27.

The extension keeps a marked block in `~/.ssh/config` for each container (including `LocalForward` entries for `forwardPorts`). Other SSH entries are left untouched.

---

## Requirements

| Requirement | Version |
|---|---|
| macOS | 26+ (Apple Silicon) |
| Apple `container` CLI | 1.7.1+ (`container --version`) |
| VS Code | 1.95+ |
| VS Code extension | **Remote - SSH** (`ms-vscode-remote.remote-ssh`) |
| `sshd` in the image | installed automatically if missing (apt, apk, dnf, yum, pacman), or via `postCreateCommand` |

---

## Installation

The extension is not published yet.

Building from a checkout requires Node.js 20+ and pnpm.

```bash
# from a checkout
pnpm install
pnpm build
pnpm dlx @vscode/vsce package --no-dependencies
# then: Extensions → … → Install from VSIX, or run the Extension Development Host with F5
```

---

## Usage

1. Add a `.devcontainer/devcontainer.json` to your project (or reuse an existing one).
2. Open the Command Palette and run **macOS Container: Reopen Folder in Container**.
3. The extension creates the container, configures SSH, and opens a new window connected to it.

Available commands:

| Command | Purpose |
|---|---|
| **macOS Container: Reopen Folder in Container** | Create or start the container, configure SSH, and open the workspace |
| **macOS Container: Rebuild Container** | Remove the existing container and recreate it from the current configuration |
| **macOS Container: Remove Container** | Remove the container and its managed SSH config block |
| **macOS Container: Show Log** | Open the extension output channel |

### End-to-end example

The [`examples/node`](examples/node) folder is a small test project with a
`devcontainer.json`, an SSH server bootstrap, and a Node.js server on port 3000.
See its [README](examples/node/README.md) for the exact steps to run it in the
Extension Development Host.

### Example `devcontainer.json`

```jsonc
{
  "name": "Node.js Dev",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:4-24-bookworm",
  "remoteUser": "root",
  "workspaceFolder": "/workspaces/my-project",
  "forwardPorts": [5173, 3000],
  "postCreateCommand": "apt-get update && apt-get install -y openssh-server && mkdir -p /run/sshd",
  "postStartCommand": "/usr/sbin/sshd",
  "hostRequirements": {
    "cpus": 4,
    "memory": "4GB"
  }
}
```

> Most stock images do not run an SSH server. The extension installs `openssh-server` automatically when it is missing (Debian/Ubuntu, Alpine, Fedora/RHEL, Arch), or you can add it through `postCreateCommand`.

---

## Configuration

Supported today / planned:

- [x] `image`
- [x] `workspaceFolder`
- [x] `remoteUser`
- [x] `forwardPorts`
- [x] `postCreateCommand`
- [x] `postStartCommand`
- [x] `hostRequirements.cpus` / `hostRequirements.memory`
- [ ] `build.dockerfile` / `build.context`
- [ ] `mounts`
- [ ] `features`
- [ ] `containerEnv`
- [ ] `runArgs`

Unsupported keys are ignored with a warning.

---

## Known limitations

These are properties of the current Apple `container` runtime and macOS, not of this extension:

- **Published ports (`-p`) do not work.** On macOS 27 they accept connections and then reset (`EHOSTUNREACH` from the forwarder). Use the container's direct IP or an SSH tunnel.
- **Protected folders cannot be mounted.** Paths under `~/Desktop`, `~/Documents` and `~/Downloads` hang the container during share setup because macOS privacy blocks `open()`. Keep projects in a normal directory such as `~/Projects`.
- **One VM per container.** Expect roughly 300–400 MB of host memory per running container before the workload does anything. Defaults are 1 GiB RAM and 4 vCPUs; tune them with `-m` and `-c` / `hostRequirements`.
- **No Docker API.** `docker compose`, `buildx` and Docker-specific tooling are out of scope.
- **Daemon recovery.** A failed mount can wedge the service; it may need `kill -9` on the container helpers.
- Apple `container` on macOS 27 is ahead of its officially supported macOS 26 baseline. Treat it as experimental.

---

## How it compares

| | Official Dev Containers | Apple Container Manager | macdevcontainer |
|---|---|---|---|
| Backend | Docker / Podman | Apple `container` | Apple `container` |
| Config file | `.devcontainer/devcontainer.json` | `.appcontainer/devcontainer.json` | `.devcontainer/devcontainer.json` |
| VS Code connection | container API | Remote - SSH | Remote - SSH |
| Needs `-p` publishing | yes | yes (brittle on macOS 27) | **no** — direct container IP |
| Maturity | stable | early | early |

---

## Roadmap

- [ ] MVP: reopen folder in a container via Remote - SSH over the container IP
- [ ] `devcontainer.json` subset (image, commands, ports, resources)
- [ ] SSH port forwarding for `forwardPorts`
- [ ] Dockerfile-based builds (`build.dockerfile`, `build.args`)
- [ ] `mounts` and named volumes
- [ ] `features` support
- [ ] Marketplace release
- [ ] Optional: Docker-API shim so the official extension can work unchanged

---

## Development

```bash
pnpm install
pnpm build      # bundle the extension
pnpm watch      # rebuild on change

pnpm typecheck  # TypeScript only
pnpm test       # unit tests
pnpm check      # typecheck + tests + production bundle
```

Press **F5** in VS Code to launch the Extension Development Host, then run a command from the palette. CI runs the same checks on every push and pull request.

Debugging tips:

- The Apple container service must be running: `container system start --disable-kernel-install`.
- Check `container ls`, `container logs <name>` and `container exec <name> …` before blaming the extension.
- On a Background launchd session, `container system status` may falsely report “not registered”; `container ls` is the reliable check.

---

## Contributing

Issues and pull requests are welcome. Please include:

- macOS version (`sw_vers`),
- `container --version`,
- VS Code and Remote - SSH versions,
- the relevant `devcontainer.json`,
- `container logs <name>` output.

---

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Apple Inc. or Microsoft. “Apple”, “macOS”, “Visual Studio Code” and “Dev Containers” are trademarks of their respective owners.

Apple `container` is under active development. Container failures can leave stale state behind and, in the worst case, cause data loss. Keep your work in Git and use at your own risk.

---

## License

MIT © 2026 VGFP — see [LICENSE](LICENSE).
