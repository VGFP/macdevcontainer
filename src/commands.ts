import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { buildCreateArgs, lifecycleSteps } from './container/args';
import { ContainerCli } from './container/cli';
import { LocalExecutor, SshExecutor, quoteShellArg, type CommandExecutor } from './container/executor';
import { containerNameForWorkspace, projectId } from './container/naming';
import { ensureSshd, installAuthorizedKey } from './container/ssh';
import { parseDevContainer } from './devcontainer/parse';
import type { DevContainerConfig } from './devcontainer/types';
import { OutputLogger } from './log';
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
        await ensureSshd(cli, containerName, this.logger);
        const key = await ensureKeyPair(identifier);
        await installAuthorizedKey(
          cli,
          containerName,
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
