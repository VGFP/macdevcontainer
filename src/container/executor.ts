import { run, type RunOptions, type RunResult } from '../util/process';

/** Where `container` commands are executed: locally or on a Remote-SSH host. */
export interface CommandExecutor {
  readonly label: string;
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
}

/** Run commands on the machine where VS Code is running. */
export class LocalExecutor implements CommandExecutor {
  readonly label = '';

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return run(command, args, options);
  }
}

export interface SshExecutorOptions {
  sshHost: string;
  sshConfigFile?: string;
}

/**
 * Run commands on the Remote-SSH host using the existing SSH configuration.
 * This is what lets the local UI extension drive `container` on the remote Mac.
 */
export class SshExecutor implements CommandExecutor {
  readonly label: string;
  private readonly sshHost: string;
  private readonly sshConfigFile: string | undefined;

  constructor(options: SshExecutorOptions) {
    this.sshHost = options.sshHost;
    this.sshConfigFile = options.sshConfigFile;
    this.label = `ssh ${options.sshHost}`;
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runShell(buildRemoteCommand(command, args), options);
  }

  async runShell(script: string, options: RunOptions = {}): Promise<RunResult> {
    const sshArgs = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
    ];
    if (this.sshConfigFile) {
      sshArgs.push('-F', this.sshConfigFile);
    }
    sshArgs.push(this.sshHost, withRemotePath(script));

    return run('ssh', sshArgs, {
      timeoutMs: 5 * 60 * 1000,
      ...options,
    });
  }
}

/** Build a shell command line for the remote host with every argument quoted. */
export function buildRemoteCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShellArg).join(' ');
}

/** Include Homebrew and the usual local bin directories in remote commands. */
export function withRemotePath(script: string): string {
  return `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ${script}`;
}

/** POSIX single-quote escaping. */
export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
