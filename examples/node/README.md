# Node.js example

A tiny folder used to exercise `macdevcontainer` end to end: container creation,
SSH setup, Remote - SSH, and port forwarding.

The `devcontainer.json` uses the already-small `typescript-node` image and installs
`openssh-server` from `postCreateCommand`. Port `3000` is forwarded over SSH.

## Run it

From the repository root:

```bash
pnpm install
pnpm build

# Remote - SSH is required the first time
code --install-extension ms-vscode-remote.remote-ssh

# Load the extension and open this folder in the Extension Development Host
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples/node"
```

Then open the Command Palette and run:

**macOS Container: Reopen Folder in Container**

The extension creates and starts the container, installs/launches `sshd`, configures
SSH, and opens a new VS Code window connected to `/workspaces/example`.

In the new window, open a terminal and start the example:

```bash
npm start
```

Visit <http://localhost:3000> on the Mac.

## Troubleshooting

- **Stuck at mounting:** Apple container cannot share `~/Desktop`, `~/Documents`,
  or `~/Downloads`. This example lives wherever the repository lives; if that is
  a protected or external volume that misbehaves, copy `examples/node` to
  `~/Projects` and open it there.
- **`sshd` missing:** `postCreateCommand` needs network access to run `apt-get`.
  Check `container logs <name>` and the macdevcontainer output channel.
- **Service status looks wrong:** `container system status` can report
  "not registered" in a Background launchd session; `container ls` is the
  reliable check.
