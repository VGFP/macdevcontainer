import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { buildCreateArgs, lifecycleSteps } from './container/args';
import { ContainerCli, type ContainerMachineInfo } from './container/cli';
import { LocalExecutor, SshExecutor, quoteShellArg, type CommandExecutor } from './container/executor';
import {
  containerNameForWorkspace,
  machineSshHostForWorkspace,
  projectId,
} from './container/naming';
import {
  ensureSshd,
  installAuthorizedKey,
  unlockAccount,
  type CommandTarget,
} from './container/ssh';
import { parseDevContainer } from './devcontainer/parse';
import type { DevContainerConfig } from './devcontainer/types';
import { OutputLogger } from './log';
import { buildPostCreateCheckScript, buildPostCreateMarkScript } from './machine/state';
import { startSshTunnel, stopSshTunnel } from './remote/tunnel';
import { resolveSshRemoteHost } from './remote/sshHost';
import {
  defaultSshConfigPath,
  removeManagedSshBlock,
  upsertManagedSshBlock,
} from './ssh/config';
import { ensureKeyPair } from './ssh/keys';
import { verifySsh } from './ssh/verify';
import { CancelledError, errorMessage, outputTail, UserError } from './util/errors';
import { readTextFileIfExists, writePrivateFile } from './util/fs';
import { waitForTcp } from './util/net';
import { isProtectedPosixWorkspacePath, isProtectedWorkspacePath } from './workspace';
import { findDevContainerUris, readWorkspaceText, uriLabel } from './workspaceFiles';

const REMOTE_SSH_EXTENSION = 'ms-vscode-remote.remote-ssh';

export function registerCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): void {
  const controller = new CommandController(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('macdevcontainer.reopenInContainer', () =>
      controller.reopen(false),
    ),
    vscode.commands.registerCommand('macdevcontainer.rebuildContainer', () =>
      controller.reopen(true),
    ),
    vscode.commands.registerCommand('macdevcontainer.reopenInMachine', () =>
      controller.reopenInMachine(),
    ),
    vscode.commands.registerCommand('macdevcontainer.forgetMachine', () =>
      controller.forgetMachine(),
    ),
    vscode.commands.registerCommand('macdevcontainer.removeContainer', () =>
      controller.remove(),
    ),
    vscode.commands.registerCommand('macdevcontainer.showLog', () => output.show()),
  );
}

interface RunContext {
  workspaceRoot: string;
  workspaceUri: vscode.Uri;
  isRemote: boolean;
  sshHost?: string;
  sshConfigFile: string;
  executor: CommandExecutor;
  home: string;
}

class CommandController {
  private readonly logger: OutputLogger;

  constructor(output: vscode.OutputChannel) {
    this.logger = new OutputLogger(output);
  }

  async reopen(rebuild: boolean): Promise<void> {
    await this.runWithUi(
      rebuild ? 'Rebuilding container' : 'Opening folder in container',
      async (progress) => {
        const context = await this.getRunContext();
        this.assertWorkspaceIsMountable(context);

        const devContainerUri = await this.pickDevContainerFile(context.workspaceUri);
        const parsed = parseDevContainer(
          await readWorkspaceText(devContainerUri),
          uriLabel(devContainerUri),
          context.workspaceRoot,
        );
        for (const warning of parsed.warnings) {
          this.logger.warn(warning);
        }
        if (parsed.warnings.length > 0) {
          void vscode.window.showWarningMessage(parsed.warnings.join(' '));
        }

        const config = parsed.config;
        const settings = vscode.workspace.getConfiguration('macdevcontainer');
        const cli = new ContainerCli({
          containerPath: settings.get<string>('containerPath', 'container'),
          executor: context.executor,
          logger: this.logger,
        });
        const autoStart = settings.get<boolean>('autoStartService', true);
        const containerName = containerNameForWorkspace(context.workspaceRoot);
        const identifier = projectId(context.workspaceRoot);

        progress.report({ message: 'Checking the Apple container service…' });
        await cli.ensureService(autoStart);

        if (rebuild) {
          await stopSshTunnel(identifier);
          const existing = await cli.inspect(containerName);
          if (existing) {
            progress.report({ message: `Removing container ${containerName}…` });
            await cli.delete(containerName);
          }
        }

        progress.report({ message: `Preparing image ${config.image}…` });
        if (!(await cli.imageExists(config.image))) {
          await cli.pullImage(config.image);
        }

        let info = await cli.inspect(containerName);
        let started = false;

        if (!info) {
          progress.report({ message: `Creating container ${containerName}…` });
          await cli.create(
            buildCreateArgs({
              containerName,
              workspaceRoot: context.workspaceRoot,
              image: config.image,
              config,
            }),
          );
          await cli.start(containerName);
          started = true;
          info = await cli.waitForRunning(containerName);
          await this.runLifecycle(
            cli,
            containerName,
            config,
            'postCreateCommand',
            config.postCreateCommand,
            config.workspaceFolder,
            progress,
          );
        } else if (info.state !== 'running') {
          progress.report({ message: `Starting container ${containerName}…` });
          await cli.start(containerName);
          started = true;
          info = await cli.waitForRunning(containerName);
        } else {
          info = await cli.waitForRunning(containerName);
        }

        if (started) {
          await this.runLifecycle(
            cli,
            containerName,
            config,
            'postStartCommand',
            config.postStartCommand,
            config.workspaceFolder,
            progress,
          );
        }

        const running = info ?? (await cli.waitForRunning(containerName));
        const address = running.ipv4Address;
        if (!address) {
          throw new UserError('The container did not report an IPv4 address.');
        }

        progress.report({ message: 'Configuring SSH…' });
        const target: CommandTarget = {
          label: `container ${containerName}`,
          shell: (script, options) => cli.exec(containerName, ['sh', '-c', script], options),
        };
        await ensureSshd(target, this.logger);
        const key = await ensureKeyPair(identifier);
        await installAuthorizedKey(
          target,
          config.remoteUser,
          key.publicKey,
          identifier,
        );

        let hostName = address;
        let port: number | undefined;

        if (context.isRemote) {
          if (!context.sshHost) {
            throw new UserError('Could not determine the Remote-SSH host.');
          }
          progress.report({ message: 'Opening an SSH tunnel through the remote host…' });
          const tunnel = await startSshTunnel({
            projectId: identifier,
            sshHost: context.sshHost,
            sshConfigFile: context.sshConfigFile,
            containerIp: address,
            logger: this.logger,
          });
          hostName = '127.0.0.1';
          port = tunnel.port;
        }

        const identityFile = key.privateKeyPath.replace(/\\/g, '/');
        const existingConfig = (await readTextFileIfExists(context.sshConfigFile)) ?? '';
        await writePrivateFile(
          context.sshConfigFile,
          upsertManagedSshBlock(existingConfig, {
            host: containerName,
            hostName,
            port,
            user: config.remoteUser,
            identityFile,
            forwardPorts: config.forwardPorts,
          }),
        );

        progress.report({ message: 'Verifying the SSH connection…' });
        await waitForTcp(hostName, port ?? 22, context.isRemote ? 20_000 : 30_000);
        await verifySsh(containerName, context.sshConfigFile);

        await this.ensureRemoteSshExtension();
        progress.report({ message: 'Opening the VS Code window…' });

        const encodedPath = config.workspaceFolder
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        const uri = vscode.Uri.parse(
          `vscode-remote://ssh-remote+${containerName}${encodedPath}`,
        );
        const openInNewWindow = settings.get<boolean>('openInNewWindow', true);
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          uri,
          openInNewWindow ? { forceNewWindow: true } : { forceReuseWindow: true },
        );
      },
    );
  }

  /**
   * Open the workspace in an existing Apple container machine instead of
   * creating a dedicated dev container. Container machines mount the macOS home
   * directory at the same path, so the workspace is already available.
   */
  async reopenInMachine(): Promise<void> {
    await this.runWithUi('Opening folder in container machine', async (progress) => {
      const context = await this.getRunContext();
      this.assertWorkspaceIsMountable(context);

      const devContainerUri = await this.pickDevContainerFile(context.workspaceUri);
      const parsed = parseDevContainer(
        await readWorkspaceText(devContainerUri),
        uriLabel(devContainerUri),
        context.workspaceRoot,
        { requireImage: false },
      );
      for (const warning of parsed.warnings) {
        this.logger.warn(warning);
      }

      const config = parsed.config;
      const settings = vscode.workspace.getConfiguration('macdevcontainer');
      const cli = new ContainerCli({
        containerPath: settings.get<string>('containerPath', 'container'),
        executor: context.executor,
        logger: this.logger,
      });
      const autoStart = settings.get<boolean>('autoStartService', true);
      const identifier = projectId(context.workspaceRoot);

      progress.report({ message: 'Checking the Apple container service…' });
      await cli.ensureService(autoStart);

      const machine = await this.resolveMachine(cli, settings);
      if (config.image.length > 0) {
        this.logger.info(
          `Ignoring "image" (${config.image}); container machine ${machine.id} provides its own image.`,
        );
      }
      if (
        config.hostRequirements.cpus !== undefined ||
        config.hostRequirements.memory !== undefined
      ) {
        this.logger.info(
          `Ignoring "hostRequirements"; change the machine with "container machine set -n ${machine.id}".`,
        );
      }
      this.logger.info(
        `Container machine ${machine.id} uses ${context.workspaceRoot} as the workspace folder; "workspaceFolder" and "remoteUser" are not used.`,
      );

      if (machine.homeMount === 'none') {
        throw new UserError(
          `The container machine "${machine.id}" does not mount your home directory.`,
          `Enable it with "container machine set -n ${machine.id} home-mount=rw", then restart the machine.`,
        );
      }

      progress.report({ message: `Preparing container machine ${machine.id}…` });
      const wasRunning = machine.status === 'running';

      // Running a command boots the machine when necessary. Pin the workdir so
      // macOS privacy never blocks the CLI while it resolves its host cwd.
      const probe = await cli.machineShell(
        machine.id,
        `test -d ${quoteShellArg(context.workspaceRoot)} && cd -- ${quoteShellArg(context.workspaceRoot)} && pwd -P`,
        { timeoutMs: 5 * 60 * 1000 },
      );
      if (probe.code !== 0) {
        throw new UserError(
          `The container machine "${machine.id}" cannot access this workspace.`,
          [
            outputTail(probe.stderr || probe.stdout),
            `Container machines expose your macOS home directory (${context.home}) at the same path. Move the project under that directory.`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
      }

      const resolvedWorkspace = lastLine(probe.stdout) || context.workspaceRoot;
      const info = (await cli.machineInspect(machine.id)) ?? machine;
      if (!info.ipAddress) {
        throw new UserError(
          `The container machine "${machine.id}" did not report an IP address.`,
          'Check "container machine inspect" and make sure the machine is running.',
        );
      }
      if (info.homeMount === 'ro') {
        this.logger.warn(
          'The container machine mounts your home directory read-only; edits in the workspace will fail.',
        );
      }

      const machineUser = info.username;
      if (!machineUser) {
        throw new UserError(
          `The container machine "${machine.id}" did not report a user account.`,
          'Recreate the machine so it provisions a guest user for your macOS account.',
        );
      }

      const target: CommandTarget = {
        label: `container machine ${machine.id}`,
        shell: (script, options) => cli.machineShell(machine.id, script, options),
      };

      const postCreateDone = await this.machinePostCreateDone(cli, machine.id, identifier);
      if (!postCreateDone) {
        await this.runMachineLifecycle(
          cli,
          machine.id,
          'postCreateCommand',
          config.postCreateCommand,
          resolvedWorkspace,
          progress,
        );
        const marked = await cli.machineShell(
          machine.id,
          buildPostCreateMarkScript(identifier),
          { timeoutMs: 30_000 },
        );
        if (marked.code !== 0) {
          this.logger.warn(
            `Could not record postCreateCommand state in container machine ${machine.id}: ${outputTail(marked.stderr || marked.stdout)}`,
          );
        }
      }

      if (!wasRunning) {
        await this.runMachineLifecycle(
          cli,
          machine.id,
          'postStartCommand',
          config.postStartCommand,
          resolvedWorkspace,
          progress,
        );
      }

      progress.report({ message: 'Configuring SSH…' });
      await unlockAccount(target, machineUser);
      await ensureSshd(target, this.logger);
      const key = await ensureKeyPair(identifier);
      await installAuthorizedKey(target, machineUser, key.publicKey, identifier);

      let hostName = info.ipAddress;
      let port: number | undefined;

      if (context.isRemote) {
        if (!context.sshHost) {
          throw new UserError('Could not determine the Remote-SSH host.');
        }
        progress.report({ message: 'Opening an SSH tunnel through the remote host…' });
        const tunnel = await startSshTunnel({
          projectId: identifier,
          sshHost: context.sshHost,
          sshConfigFile: context.sshConfigFile,
          containerIp: info.ipAddress,
          logger: this.logger,
        });
        hostName = '127.0.0.1';
        port = tunnel.port;
      }

      const sshHost = machineSshHostForWorkspace(context.workspaceRoot);
      const identityFile = key.privateKeyPath.replace(/\\/g, '/');
      const existingConfig = (await readTextFileIfExists(context.sshConfigFile)) ?? '';
      await writePrivateFile(
        context.sshConfigFile,
        upsertManagedSshBlock(existingConfig, {
          host: sshHost,
          hostName,
          port,
          user: machineUser,
          identityFile,
          forwardPorts: config.forwardPorts,
        }),
      );

      progress.report({ message: 'Verifying the SSH connection…' });
      await waitForTcp(hostName, port ?? 22, context.isRemote ? 20_000 : 30_000);
      await verifySsh(sshHost, context.sshConfigFile);

      await this.ensureRemoteSshExtension();
      progress.report({ message: 'Opening the VS Code window…' });

      const encodedPath = resolvedWorkspace
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      const uri = vscode.Uri.parse(
        `vscode-remote://ssh-remote+${sshHost}${encodedPath}`,
      );
      const openInNewWindow = settings.get<boolean>('openInNewWindow', true);
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        uri,
        openInNewWindow ? { forceNewWindow: true } : { forceReuseWindow: true },
      );
    });
  }

  /** Remove the managed SSH connection for this workspace's container machine. */
  async forgetMachine(): Promise<void> {
    await this.runWithUi('Forgetting container machine connection', async () => {
      const context = await this.getRunContext();
      const identifier = projectId(context.workspaceRoot);
      await stopSshTunnel(identifier);
      await this.removeSshConfig(
        context.sshConfigFile,
        machineSshHostForWorkspace(context.workspaceRoot),
      );
      void vscode.window.showInformationMessage(
        'Removed the container machine SSH connection for this folder. The container machine itself was not changed.',
      );
    });
  }

  async remove(): Promise<void> {
    await this.runWithUi('Removing container', async (progress) => {
      const context = await this.getRunContext();
      const settings = vscode.workspace.getConfiguration('macdevcontainer');
      const cli = new ContainerCli({
        containerPath: settings.get<string>('containerPath', 'container'),
        executor: context.executor,
        logger: this.logger,
      });
      const containerName = containerNameForWorkspace(context.workspaceRoot);
      const identifier = projectId(context.workspaceRoot);
      const info = await cli.inspect(containerName);

      if (!info) {
        void vscode.window.showInformationMessage(
          `No macdevcontainer container exists for this folder (${containerName}).`,
        );
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Remove container "${containerName}"? Files in your workspace are not affected.`,
        { modal: true },
        'Remove',
      );
      if (confirmation !== 'Remove') {
        throw new CancelledError();
      }

      progress.report({ message: `Removing container ${containerName}…` });
      await stopSshTunnel(identifier);
      await cli.delete(containerName);
      await this.removeSshConfig(context.sshConfigFile, containerName);
      void vscode.window.showInformationMessage(`Removed container "${containerName}".`);
    });
  }

  private async runWithUi(
    title: string,
    task: (
      progress: vscode.Progress<{ message?: string; increment?: number }>,
    ) => Promise<void>,
  ): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: false,
        },
        task,
      );
    } catch (error) {
      if (error instanceof CancelledError) {
        return;
      }
      const message = errorMessage(error);
      const detail = error instanceof UserError ? error.detail : undefined;
      this.logger.error(detail ? `${message}\n${detail}` : message);
      const selection = await vscode.window.showErrorMessage(message, 'Show Log');
      if (selection === 'Show Log') {
        this.logger.show();
      }
    }
  }

  private async runLifecycle(
    cli: ContainerCli,
    containerName: string,
    config: DevContainerConfig,
    key: string,
    command: DevContainerConfig['postCreateCommand'],
    workdir: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    for (const step of lifecycleSteps(command, key)) {
      progress.report({ message: `Running ${step.label}…` });
      this.logger.info(`Running ${step.label}: ${step.command}`);
      const result = await cli.exec(containerName, ['sh', '-c', step.command], {
        user: config.remoteUser,
        workdir,
        timeoutMs: 30 * 60 * 1000,
      });
      if (result.code !== 0) {
        throw new UserError(
          `${step.label} failed with exit code ${result.code}.`,
          result.stderr || result.stdout,
        );
      }
    }
  }

  private async runMachineLifecycle(
    cli: ContainerCli,
    machineName: string,
    key: string,
    command: DevContainerConfig['postCreateCommand'],
    workdir: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    for (const step of lifecycleSteps(command, key)) {
      progress.report({ message: `Running ${step.label}…` });
      this.logger.info(
        `Running ${step.label} in container machine ${machineName}: ${step.command}`,
      );
      const result = await cli.machineShell(machineName, step.command, {
        workdir,
        timeoutMs: 30 * 60 * 1000,
      });
      if (result.code !== 0) {
        throw new UserError(
          `${step.label} failed with exit code ${result.code} in container machine ${machineName}.`,
          result.stderr || result.stdout,
        );
      }
    }
  }

  private async machinePostCreateDone(
    cli: ContainerCli,
    machineName: string,
    identifier: string,
  ): Promise<boolean> {
    const result = await cli.machineShell(
      machineName,
      buildPostCreateCheckScript(identifier),
      { timeoutMs: 30_000 },
    );
    return result.code === 0;
  }

  private async resolveMachine(
    cli: ContainerCli,
    settings: vscode.WorkspaceConfiguration,
  ): Promise<ContainerMachineInfo> {
    const configured = settings.get<string>('machine', '').trim();
    if (configured.length > 0) {
      const info = await cli.machineInspect(configured);
      if (!info) {
        throw new UserError(
          `Container machine "${configured}" was not found.`,
          'Check "container machine ls" or update macdevcontainer.machine.',
        );
      }
      return info;
    }

    const machines = await cli.machineList();
    if (machines.length === 0) {
      throw new UserError(
        'No container machine was found.',
        'Create one with "container machine create <image> --name <name>", then try again.',
      );
    }

    const preferred = machines.find((machine) => machine.isDefault);
    if (preferred) {
      return (await cli.machineInspect(preferred.id)) ?? preferred;
    }

    const only = machines[0];
    if (machines.length === 1 && only) {
      return (await cli.machineInspect(only.id)) ?? only;
    }

    const picked = await vscode.window.showQuickPick(
      machines.map((machine) => ({
        label: machine.id,
        description: [machine.status, machine.isDefault ? 'default' : undefined, machine.ipAddress]
          .filter(Boolean)
          .join(' • '),
        machineId: machine.id,
      })),
      { placeHolder: 'Select a container machine' },
    );
    if (!picked) {
      throw new CancelledError();
    }

    const info = await cli.machineInspect(picked.machineId);
    if (info) {
      return info;
    }
    const fallback = machines.find((machine) => machine.id === picked.machineId);
    if (fallback) {
      return fallback;
    }
    throw new UserError(`Container machine "${picked.machineId}" was not found.`);
  }

  private async getRunContext(): Promise<RunContext> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new UserError('Open a folder before using macdevcontainer.');
    }
    if (folders.length > 1) {
      throw new UserError('macdevcontainer currently supports a single workspace folder.');
    }

    const folder = folders[0];
    if (!folder) {
      throw new UserError('No workspace folder is open.');
    }

    const sshConfigFile = resolveSshConfigFile();
    const remoteName = vscode.env.remoteName;
    const remoteAuthority =
      folder.uri.scheme === 'vscode-remote' ? folder.uri.authority : undefined;
    const isRemote = Boolean(remoteName) || folder.uri.scheme === 'vscode-remote';

    if (isRemote) {
      const sshHost = resolveSshRemoteHost(remoteName, remoteAuthority);
      if (!sshHost) {
        throw new UserError(
          'Only Remote-SSH workspaces are supported for remote development.',
          `Current remote: ${remoteName ?? 'unknown'}; workspace authority: ${remoteAuthority ?? 'unknown'}`,
        );
      }

      this.logger.info(
        `Remote workspace detected. SSH host: ${sshHost}; SSH config: ${sshConfigFile}; authority: ${remoteAuthority ?? 'n/a'}.`,
      );
      const executor = new SshExecutor({
        sshHost,
        sshConfigFile,
      });
      const workspaceRoot = await resolveRemotePath(executor, folder.uri.path);
      const home = await readRemoteHome(executor);

      return {
        workspaceRoot,
        workspaceUri: folder.uri,
        isRemote: true,
        sshHost,
        sshConfigFile,
        executor,
        home,
      };
    }

    if (folder.uri.scheme !== 'file') {
      throw new UserError(`Unsupported workspace URI: ${folder.uri.toString()}`);
    }

    return {
      workspaceRoot: await realpath(folder.uri.fsPath),
      workspaceUri: folder.uri,
      isRemote: false,
      sshConfigFile,
      executor: new LocalExecutor(),
      home: homedir(),
    };
  }

  private assertWorkspaceIsMountable(context: RunContext): void {
    const protectedPath = context.isRemote
      ? isProtectedPosixWorkspacePath(context.workspaceRoot, context.home)
      : isProtectedWorkspacePath(context.workspaceRoot, context.home);
    if (protectedPath) {
      throw new UserError(
        'This folder is protected by macOS privacy and cannot be mounted by Apple container.',
        `Move the project to a normal folder such as ${context.home}/Projects (not Desktop, Documents, or Downloads).`,
      );
    }
  }

  private async pickDevContainerFile(root: vscode.Uri): Promise<vscode.Uri> {
    const files = await findDevContainerUris(root);
    if (files.length === 0) {
      throw new UserError(
        'No devcontainer configuration found.',
        'Add .devcontainer/devcontainer.json (or .devcontainer.json) to this workspace.',
      );
    }
    if (files.length === 1) {
      return files[0]!;
    }

    const picked = await vscode.window.showQuickPick(
      files.map((file) => ({
        label: vscode.workspace.asRelativePath(file),
        uri: file,
      })),
      { placeHolder: 'Select a devcontainer configuration' },
    );
    if (!picked) {
      throw new CancelledError();
    }
    return picked.uri;
  }

  private async ensureRemoteSshExtension(): Promise<void> {
    if (vscode.extensions.getExtension(REMOTE_SSH_EXTENSION)) {
      return;
    }

    const install = 'Install Remote - SSH';
    const choice = await vscode.window.showWarningMessage(
      'macdevcontainer needs the "Remote - SSH" extension to open the container.',
      install,
      'Cancel',
    );
    if (choice !== install) {
      throw new CancelledError();
    }

    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      REMOTE_SSH_EXTENSION,
    );
  }

  private async removeSshConfig(sshConfigFile: string, containerName: string): Promise<void> {
    const existing = await readTextFileIfExists(sshConfigFile);
    if (existing === undefined) {
      return;
    }
    await writePrivateFile(sshConfigFile, removeManagedSshBlock(existing, containerName));
  }
}

function lastLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ''
  );
}

function resolveSshConfigFile(): string {
  const configured = vscode.workspace
    .getConfiguration('remote.SSH')
    .get<string>('configFile');
  if (!configured || configured.trim().length === 0) {
    return defaultSshConfigPath();
  }

  const value = configured.trim();
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : join(homedir(), value);
}

async function resolveRemotePath(executor: SshExecutor, path: string): Promise<string> {
  const result = await executor.runShell(`cd -- ${quoteShellArg(path)} && pwd -P`, {
    timeoutMs: 30_000,
  });
  const resolved = result.stdout.trim();
  if (result.code !== 0 || resolved.length === 0) {
    throw new UserError(
      'Could not access the workspace folder on the remote host.',
      outputTail(result.stderr || result.stdout),
    );
  }
  return resolved;
}

async function readRemoteHome(executor: SshExecutor): Promise<string> {
  const result = await executor.runShell('printf %s "$HOME"', { timeoutMs: 30_000 });
  const home = result.stdout.trim();
  if (result.code !== 0 || home.length === 0) {
    throw new UserError(
      'Could not determine the remote home directory.',
      outputTail(result.stderr || result.stdout),
    );
  }
  return home;
}
