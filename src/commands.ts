import { readFile, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { buildCreateArgs, lifecycleSteps } from './container/args';
import { ContainerCli, waitForTcp } from './container/cli';
import { containerNameForWorkspace, projectId } from './container/naming';
import { ensureSshd, installAuthorizedKey } from './container/ssh';
import { parseDevContainer } from './devcontainer/parse';
import type { DevContainerConfig } from './devcontainer/types';
import { OutputLogger } from './log';
import {
  defaultSshConfigPath,
  removeManagedSshBlock,
  upsertManagedSshBlock,
} from './ssh/config';
import { ensureKeyPair } from './ssh/keys';
import { verifySsh } from './ssh/verify';
import { CancelledError, errorMessage, UserError } from './util/errors';
import { readTextFileIfExists, writePrivateFile } from './util/fs';
import { findDevContainerFiles, isProtectedWorkspacePath } from './workspace';

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

class CommandController {
  private readonly logger: OutputLogger;

  constructor(output: vscode.OutputChannel) {
    this.logger = new OutputLogger(output);
  }

  async reopen(rebuild: boolean): Promise<void> {
    await this.runWithUi(
      rebuild ? 'Rebuilding container' : 'Opening folder in container',
      async (progress) => {
        const workspaceRoot = await this.getWorkspaceRoot();
        this.assertWorkspaceIsMountable(workspaceRoot);

        const devContainerFile = await this.pickDevContainerFile(workspaceRoot);
        const parsed = parseDevContainer(
          await readFile(devContainerFile, 'utf8'),
          devContainerFile,
          workspaceRoot,
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
          logger: this.logger,
        });
        const autoStart = settings.get<boolean>('autoStartService', true);
        const containerName = containerNameForWorkspace(workspaceRoot);
        const identifier = projectId(workspaceRoot);

        progress.report({ message: 'Checking the Apple container service…' });
        await cli.ensureService(autoStart);

        if (rebuild) {
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
              workspaceRoot,
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

        const address = running.ipv4Address;
        if (!address) {
          throw new UserError('The container did not report an IPv4 address.');
        }

        const sshConfigFile = defaultSshConfigPath();
        const existingConfig = (await readTextFileIfExists(sshConfigFile)) ?? '';
        await writePrivateFile(
          sshConfigFile,
          upsertManagedSshBlock(existingConfig, {
            host: containerName,
            hostName: address,
            user: config.remoteUser,
            identityFile: key.privateKeyPath,
            forwardPorts: config.forwardPorts,
          }),
        );

        progress.report({ message: 'Verifying the SSH connection…' });
        await waitForTcp(address, 22, 30_000);
        await verifySsh(containerName, sshConfigFile);

        await this.ensureRemoteSshExtension();
        progress.report({ message: 'Opening the VS Code window…' });

        const uri = vscode.Uri.from({
          scheme: 'vscode-remote',
          authority: `ssh-remote+${containerName}`,
          path: config.workspaceFolder,
        });
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
      const workspaceRoot = await this.getWorkspaceRoot();
      const settings = vscode.workspace.getConfiguration('macdevcontainer');
      const cli = new ContainerCli({
        containerPath: settings.get<string>('containerPath', 'container'),
        logger: this.logger,
      });
      const containerName = containerNameForWorkspace(workspaceRoot);
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
      await cli.delete(containerName);
      await this.removeSshConfig(containerName);
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

  private async getWorkspaceRoot(): Promise<string> {
    if (vscode.env.remoteName) {
      throw new UserError(
        'Run this command from a local VS Code window, not from inside a remote session.',
      );
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new UserError('Open a folder before using macdevcontainer.');
    }
    if (folders.length > 1) {
      throw new UserError('macdevcontainer currently supports a single workspace folder.');
    }

    const folder = folders[0];
    if (!folder || folder.uri.scheme !== 'file') {
      throw new UserError('macdevcontainer requires a local folder.');
    }
    return realpath(folder.uri.fsPath);
  }

  private assertWorkspaceIsMountable(workspaceRoot: string): void {
    if (isProtectedWorkspacePath(workspaceRoot)) {
      throw new UserError(
        'This folder is protected by macOS privacy and cannot be mounted by Apple container.',
        'Move the project to a normal folder such as ~/Projects (not Desktop, Documents, or Downloads).',
      );
    }
  }

  private async pickDevContainerFile(workspaceRoot: string): Promise<string> {
    const files = await findDevContainerFiles(workspaceRoot);
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
        file,
      })),
      { placeHolder: 'Select a devcontainer configuration' },
    );
    if (!picked) {
      throw new CancelledError();
    }
    return picked.file;
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

  private async removeSshConfig(containerName: string): Promise<void> {
    const sshConfigFile = defaultSshConfigPath();
    const existing = await readTextFileIfExists(sshConfigFile);
    if (existing === undefined) {
      return;
    }
    await writePrivateFile(sshConfigFile, removeManagedSshBlock(existing, containerName));
  }
}
