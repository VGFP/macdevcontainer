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
5. Open a new VS Code window using Remote - SSH, connecting to the container rather than a published host port.
6. Forward `forwardPorts` through the SSH connection.

Using the container IP sidesteps the broken `container run -p` path on macOS 27.

The extension keeps a marked block in `~/.ssh/config` for each container (including `LocalForward` entries for `forwardPorts`). Other SSH entries are left untouched.

### Remote workspaces (Remote - SSH)

The extension is a **UI extension** (`extensionKind: ["ui"]`), like Microsoft's Dev Containers extension. When the current window is a Remote-SSH workspace:

- all `container` commands and container lifecycle hooks execute on the Remote-SSH host through your existing SSH connection;
- the extension opens a local SSH tunnel from your machine to the container through that host;
- the container's SSH config, key, and forwarding entries are written on your local machine;
- Remote-SSH opens the container from the local side.

No extension installation is required on the remote host. Both `ssh` and `ssh-keygen` must be available locally; Remote - SSH already requires them.

---

## Requirements

| Requirement | Version |
|---|---|
| macOS | 26+ (Apple Silicon) |
| Apple `container` CLI | 1.7.1+ (`container --version`) |
| VS Code | 1.145+ |
| VS Code extension | **Remote - SSH** (`ms-vscode-remote.remote-ssh`) |
| `sshd` in the image | installed automatically if missing (apt, apk, dnf, yum, pacman), or via `postCreateCommand` |

---

## Installation

The extension is not published yet.

Building from a checkout requires Node.js 20+ and pnpm. Install the resulting VSIX in your **local** VS Code window. For a remote workspace, the extension runs locally and connects to the Mac through the existing Remote - SSH host.

```bash
# from a checkout
pnpm install
pnpm build
pnpm dlx @vscode/vsce package --no-dependencies
# then: Extensions → … → Install from VSIX, or run the Extension Development Host with F5
```

### Verifying the download

Every GitHub Release publishes the extension together with its SHA-256 digest: as a `macdevcontainer.vsix.sha256` asset next to the VSIX, and printed in the release notes. After downloading both files from the [releases page](https://github.com/VGFP/macdevcontainer/releases):

```bash
sha256sum -c macdevcontainer.vsix.sha256      # Linux
shasum -a 256 -c macdevcontainer.vsix.sha256  # macOS
```

The digest covers the GitHub Release asset. The Marketplace copy is published from the same VSIX in the same workflow run.

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
| **macOS Container: Reopen Folder in Container Machine** | Open the workspace inside an existing Apple [container machine](https://github.com/apple/container/blob/main/docs/container-machine.md) |
| **macOS Container: Forget Container Machine Connection** | Remove the managed SSH entry for the container machine without deleting the machine |
| **macOS Container: Remove Container** | Remove the container and its managed SSH config block |
| **macOS Container: Show Log** | Open the extension output channel |

### Container machines

Apple's **container machine** is a persistent Linux environment that mounts your
macOS home directory read-write at the same path, forwards your SSH agent, and
runs the image's init system. If you already have one, macdevcontainer can open
the current workspace directly inside it instead of creating a dedicated
container:

```bash
container machine create ubuntu:24.04 --name dev
# optional: container machine set-default dev
```

Then run **macOS Container: Reopen Folder in Container Machine**. The extension:

1. uses `macdevcontainer.machine` if set, otherwise the default machine, or
   prompts when several machines exist;
2. boots the machine if needed and checks that the workspace is reachable;
3. runs `postCreateCommand` once per project and `postStartCommand` when it had
   to start the machine;
4. installs and starts `sshd` inside the machine (using the image's package
   manager if OpenSSH is missing) and injects a per-project key;
5. opens the workspace over Remote - SSH as the machine's host-matching user.

Things to know:

- The workspace must live under your macOS home directory, because that is the
  only path a container machine mounts. `~/Desktop`, `~/Documents` and
  `~/Downloads` are still blocked by macOS privacy.
- The machine's own image and guest user are used. `image`, `workspaceFolder`,
  `remoteUser` and `hostRequirements` from `devcontainer.json` do not apply;
  `forwardPorts`, `postCreateCommand` and `postStartCommand` still do.
- Lifecycle commands run as the machine's host-matching user (passwordless
  `sudo` is available), with the workspace root as the working directory.
- The first attach installs OpenSSH into the machine if it is missing. This
  changes the machine, not the host.
- Container machines create the guest account with a locked password hash, and
  OpenSSH rejects every login for a locked account. The extension replaces the
  lock marker with an unusable password hash so public-key SSH works; password
  login remains impossible.
- This is not nested containerisation: the project runs directly in the
  machine's Linux environment, not in a new container inside it.

Set `macdevcontainer.machine` to pin a machine:

```jsonc
{
  "macdevcontainer.machine": "dev"
}
```

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
- **Protected folders cannot be mounted.** Paths under `~/Desktop`, `~/Documents` and `~/Downloads` hang the container during share setup because macOS privacy blocks `open()`. Keep projects in a normal directory such as `~/Projects`. This applies to the remote host too: a Remote-SSH workspace under the remote user's `~/Desktop` cannot be mounted.
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
pnpm check      # typecheck + tests + bundle + bundle activation check
```

Press **F5** in VS Code to launch the Extension Development Host, then run a command from the palette. CI runs the same checks on every push and pull request.

Debugging tips:

- The Apple container service must be running: `container system start --disable-kernel-install`.
- Check `container ls`, `container logs <name>` and `container exec <name> …` before blaming the extension.
- On a Background launchd session, `container system status` may falsely report “not registered”; `container ls` is the reliable check.

---

## Releasing

`pnpm package` builds `macdevcontainer.vsix` locally. CI also packages the extension and uploads the VSIX as an artifact on every push and pull request.

Merging to `main` runs CI first. If CI succeeds, the `Release` workflow:

1. checks out the commit that passed CI,
2. bumps the patch version locally from the latest `vX.Y.Z` tag (or the selected bump for a manual run),
3. packages the VSIX and computes its SHA-256 digest,
4. creates a `vX.Y.Z` tag and a GitHub Release with the VSIX and its `.sha256` checksum attached (the digest is also printed in the release notes),
5. publishes to the VS Code Marketplace using Trusted Publishing (OIDC).

The workflow does not push commits to `main`, so the `main protection` ruleset stays intact. `package.json` on `main` keeps the last committed version; released versions live in tags and GitHub Releases.

Marketplace publishing uses GitHub Actions OIDC, so no long-lived token is stored. The publisher (`VGFP`) needs a Trusted Publishing policy for repository owner `VGFP`, repository `macdevcontainer`, and workflow `release.yml`. The release job requests `id-token: write` and publishes with `vsce publish --oidc`.

Run **Actions → Release → Run workflow** to release manually and choose `patch`, `minor`, or `major`.

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
