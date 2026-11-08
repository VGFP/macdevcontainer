import { homedir } from 'node:os';
import { UserError, outputTail } from '../util/errors';
import { type Logger, silentLogger } from '../util/logger';
import { delay, type RunOptions, type RunResult } from '../util/process';
import { buildExecArgs, buildMachineRunArgs, type ExecOptions, type MachineExecOptions } from './args';
import { LocalExecutor, quoteShellArg, type CommandExecutor } from './executor';

export interface ContainerInfo {
  id: string;
  state: string;
  ipv4Address?: string;
}

/** Subset of `container machine inspect` / `container machine ls` output. */
export interface ContainerMachineInfo {
  id: string;
  status: string;
  ipAddress?: string;
  isDefault: boolean;
  username?: string;
  home?: string;
  homeMount?: string;
  cpus?: number;
  memory?: number;
}

export interface ContainerCliOptions {
  containerPath?: string;
  logger?: Logger;
  executor?: CommandExecutor;
}

/** Thin, testable wrapper around the Apple `container` CLI. */
export class ContainerCli {
  private readonly cliPath: string;
  private readonly logger: Logger;
  private readonly executor: CommandExecutor;

  constructor(options: ContainerCliOptions = {}) {
    this.cliPath = options.containerPath?.trim() || 'container';
    this.logger = options.logger ?? silentLogger;
    this.executor = options.executor ?? new LocalExecutor();
  }

  get path(): string {
    return this.cliPath;
  }

  async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const prefix = this.executor.label ? `${this.executor.label} ` : '';
    this.logger.info(`$ ${prefix}${this.cliPath} ${args.join(' ')}`);
    return this.executor.run(this.cliPath, args, {
      timeoutMs: 5 * 60 * 1000,
      ...options,
    });
  }

  async runOrThrow(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      throw new UserError(
        `Apple container command failed: ${this.cliPath} ${args.slice(0, 2).join(' ')} (exit ${result.code}).`,
        outputTail(result.stderr || result.stdout),
      );
    }
    return result;
  }

  async json<T>(args: string[], options: RunOptions = {}): Promise<T> {
    const result = await this.runOrThrow(args, options);
    const text = result.stdout.trim();
    if (text.length === 0) {
      return [] as unknown as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new UserError(
        `Could not parse JSON from "${this.cliPath} ${args.join(' ')}".`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async serviceStatus(): Promise<boolean> {
    // `container system status` can falsely report "not registered" in a
    // Background launchd session. Listing containers is the reliable check.
    const result = await this.run(['ls', '--format', 'json'], { timeoutMs: 15_000 });
    return result.code === 0;
  }

  async ensureService(autoStart: boolean): Promise<void> {
    if (await this.serviceStatus()) {
      return;
    }

    if (!autoStart) {
      throw new UserError(
        'The Apple container service is not running.',
        'Start it with "container system start", or enable macdevcontainer.autoStartService.',
      );
    }

    this.logger.info('Starting the Apple container service...');
    await this.runOrThrow(['system', 'start', '--disable-kernel-install'], {
      timeoutMs: 2 * 60 * 1000,
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.serviceStatus()) {
        return;
      }
      await delay(500);
    }

    throw new UserError(
      'The Apple container service did not become ready.',
      'Try running "container system start" manually and check the output.',
    );
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.run(['image', 'inspect', image], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout || '[]');
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return false;
    }
  }

  async pullImage(image: string): Promise<void> {
    this.logger.info(`Pulling image ${image}...`);
    await this.runOrThrow(['image', 'pull', image], {
      timeoutMs: 30 * 60 * 1000,
    });
  }

  async listContainers(): Promise<ContainerInfo[]> {
    const raw = await this.json<unknown[]>(['ls', '--all', '--format', 'json'], {
      timeoutMs: 30_000,
    });
    return raw.map(toContainerInfo).filter((info): info is ContainerInfo => info !== undefined);
  }

  async inspect(containerName: string): Promise<ContainerInfo | undefined> {
    const result = await this.run(['inspect', containerName], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout || '[]');
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return undefined;
      }
      return toContainerInfo(parsed[0]);
    } catch {
      return undefined;
    }
  }

  async create(args: string[]): Promise<void> {
    await this.runOrThrow(args, { timeoutMs: 5 * 60 * 1000 });
  }

  async start(containerName: string): Promise<void> {
    const result = await this.run(['start', containerName], { timeoutMs: 2 * 60 * 1000 });
    if (result.code === 0) {
      return;
    }
    const info = await this.inspect(containerName);
    if (info?.state === 'running') {
      return;
    }
    throw new UserError(
      `Could not start container "${containerName}".`,
      outputTail(result.stderr || result.stdout),
    );
  }

  async stop(containerName: string): Promise<void> {
    const result = await this.run(['stop', containerName], { timeoutMs: 60_000 });
    if (result.code === 0) {
      return;
    }
    const info = await this.inspect(containerName);
    if (!info || info.state === 'stopped') {
      return;
    }
    throw new UserError(
      `Could not stop container "${containerName}".`,
      outputTail(result.stderr || result.stdout),
    );
  }

  async delete(containerName: string): Promise<void> {
    const result = await this.run(['delete', '--force', containerName], {
      timeoutMs: 60_000,
    });
    if (result.code === 0) {
      return;
    }
    if (!(await this.inspect(containerName))) {
      return;
    }
    throw new UserError(
      `Could not remove container "${containerName}".`,
      outputTail(result.stderr || result.stdout),
    );
  }

  async exec(
    containerName: string,
    command: readonly string[],
    options: ExecOptions & { timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const args = buildExecArgs(containerName, command, options);
    return this.run(args, { timeoutMs: options.timeoutMs });
  }

  async waitForRunning(containerName: string, timeoutMs = 2 * 60 * 1000): Promise<ContainerInfo> {
    const deadline = Date.now() + timeoutMs;
    let last: ContainerInfo | undefined;

    while (Date.now() < deadline) {
      last = await this.inspect(containerName);
      if (last?.state === 'running' && last.ipv4Address) {
        return last;
      }
      await delay(300);
    }

    throw new UserError(
      `Container "${containerName}" did not become ready.`,
      last ? `Last observed state: ${last.state}` : 'The container could not be inspected.',
    );
  }

  async machineList(): Promise<ContainerMachineInfo[]> {
    const raw = await this.json<unknown[]>(['machine', 'ls', '--format', 'json'], {
      timeoutMs: 30_000,
    });
    return raw
      .map(toMachineInfo)
      .filter((info): info is ContainerMachineInfo => info !== undefined);
  }

  async machineInspect(machineName?: string): Promise<ContainerMachineInfo | undefined> {
    const args = machineName ? ['machine', 'inspect', machineName] : ['machine', 'inspect'];
    const result = await this.run(args, { timeoutMs: 30_000 });
    if (result.code !== 0) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout || '[]');
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return undefined;
      }
      return toMachineInfo(parsed[0]);
    } catch {
      return undefined;
    }
  }

  /**
   * Run a command inside a container machine. This boots the machine when it is
   * stopped. The host working directory is pinned to the user's home so macOS
   * privacy never blocks the CLI while it resolves the current directory.
   */
  async machineExec(
    machineName: string,
    command: readonly string[],
    options: MachineExecOptions & { timeoutMs?: number; input?: string } = {},
  ): Promise<RunResult> {
    const args = buildMachineRunArgs(machineName, command, options);
    return this.run(args, {
      cwd: homedir(),
      timeoutMs: options.timeoutMs,
      input: options.input,
    });
  }

  /**
   * Run a shell script in a container machine. The script is piped over stdin
   * because `container machine run` does not preserve spaces inside arguments.
   */
  async machineShell(
    machineName: string,
    script: string,
    options: MachineExecOptions & { timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const workdir = options.workdir;
    const command = workdir
      ? `cd -- ${quoteShellArg(workdir)} || exit 1\n${script}`
      : script;
    return this.machineExec(machineName, ['sh', '-s'], {
      ...options,
      workdir: '/',
      interactive: true,
      input: command,
    });
  }
}

function toMachineInfo(value: unknown): ContainerMachineInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = typeof value.id === 'string' ? value.id : undefined;
  if (!id) {
    return undefined;
  }

  const userSetup = isRecord(value.userSetup) ? value.userSetup : {};
  const info: ContainerMachineInfo = {
    id,
    status: typeof value.status === 'string' ? value.status : 'unknown',
    isDefault: value.default === true,
  };

  if (typeof value.ipAddress === 'string' && value.ipAddress.length > 0) {
    info.ipAddress = value.ipAddress.split('/')[0];
  }
  if (typeof userSetup.username === 'string' && userSetup.username.length > 0) {
    info.username = userSetup.username;
  }
  if (typeof userSetup.home === 'string' && userSetup.home.length > 0) {
    info.home = userSetup.home;
  }
  if (typeof value.homeMount === 'string' && value.homeMount.length > 0) {
    info.homeMount = value.homeMount;
  }
  if (typeof value.cpus === 'number') {
    info.cpus = value.cpus;
  }
  if (typeof value.memory === 'number') {
    info.memory = value.memory;
  }

  return info;
}

function toContainerInfo(value: unknown): ContainerInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const configuration = isRecord(value.configuration) ? value.configuration : {};
  const status = isRecord(value.status) ? value.status : {};
  const id =
    typeof configuration.id === 'string'
      ? configuration.id
      : typeof value.id === 'string'
        ? value.id
        : undefined;
  if (!id) {
    return undefined;
  }

  const networks = Array.isArray(status.networks) ? status.networks : [];
  const network = networks.find(isRecord);
  const ipv4Address =
    network && typeof network.ipv4Address === 'string'
      ? network.ipv4Address.split('/')[0]
      : undefined;

  return {
    id,
    state: typeof status.state === 'string' ? status.state : 'unknown',
    ...(ipv4Address ? { ipv4Address } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
