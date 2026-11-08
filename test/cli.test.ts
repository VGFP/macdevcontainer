import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ContainerCli } from '../src/container/cli';
import type { CommandExecutor } from '../src/container/executor';
import type { RunOptions, RunResult } from '../src/util/process';

class FakeExecutor implements CommandExecutor {
  readonly label = '';
  readonly calls: Array<{ command: string; args: string[]; options?: RunOptions }> = [];

  constructor(private readonly responses: Record<string, string>) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ command, args, options });
    const stdout = this.responses[args.join(' ')] ?? '';
    return { stdout, stderr: '', code: stdout === '' ? 1 : 0, signal: null };
  }
}

const machineJson = JSON.stringify([
  {
    id: 'dev',
    status: 'running',
    ipAddress: '192.168.64.34',
    default: true,
    homeMount: 'rw',
    cpus: 2,
    memory: 4294967296,
    userSetup: { username: 'alice', home: '/home/alice', uid: 501, gid: 20 },
  },
]);

describe('ContainerCli container machines', () => {
  it('parses machine list output', async () => {
    const executor = new FakeExecutor({ 'machine ls --format json': machineJson });
    const cli = new ContainerCli({ executor });

    await expect(cli.machineList()).resolves.toEqual([
      {
        id: 'dev',
        status: 'running',
        ipAddress: '192.168.64.34',
        isDefault: true,
        username: 'alice',
        home: '/home/alice',
        homeMount: 'rw',
        cpus: 2,
        memory: 4294967296,
      },
    ]);
  });

  it('parses machine inspect output', async () => {
    const executor = new FakeExecutor({ 'machine inspect dev': machineJson });
    const cli = new ContainerCli({ executor });

    const info = await cli.machineInspect('dev');
    expect(info?.username).toBe('alice');
    expect(info?.ipAddress).toBe('192.168.64.34');
  });

  it('runs machine commands from the home directory with a separator', async () => {
    const executor = new FakeExecutor({});
    const cli = new ContainerCli({ executor });

    await cli.machineExec('dev', ['sh', '-c', 'echo hi'], {
      workdir: '/workspace',
      timeoutMs: 1234,
    });

    const call = executor.calls[0];
    expect(call?.args).toEqual([
      'machine',
      'run',
      '--name',
      'dev',
      '--workdir',
      '/workspace',
      '--',
      'sh',
      '-c',
      'echo hi',
    ]);
    expect(call?.options?.cwd).toBe(homedir());
    expect(call?.options?.timeoutMs).toBe(1234);
  });

  it('pipes shell scripts over stdin instead of using sh -c', async () => {
    const executor = new FakeExecutor({});
    const cli = new ContainerCli({ executor });

    await cli.machineShell('dev', 'echo hello world', {
      workdir: '/Users/test/my project',
    });

    const call = executor.calls[0];
    expect(call?.args).toEqual([
      'machine',
      'run',
      '--name',
      'dev',
      '--interactive',
      '--workdir',
      '/',
      '--',
      'sh',
      '-s',
    ]);
    expect(call?.options?.input).toBe(
      "cd -- '/Users/test/my project' || exit 1\necho hello world",
    );
  });
});
