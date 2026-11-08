import { describe, expect, it } from 'vitest';
import {
  buildCreateArgs,
  buildExecArgs,
  buildMachineRunArgs,
  CONTAINER_INIT_COMMAND,
  lifecycleSteps,
} from '../src/container/args';
import { normalizeMemory } from '../src/container/memory';
import type { DevContainerConfig } from '../src/devcontainer/types';

const config: DevContainerConfig = {
  image: 'node:22',
  remoteUser: 'root',
  workspaceFolder: '/workspaces/project',
  forwardPorts: [5173],
  hostRequirements: {},
};

describe('buildCreateArgs', () => {
  it('builds a create command with documented defaults', () => {
    const args = buildCreateArgs({
      containerName: 'macdc-project-abc',
      workspaceRoot: '/Users/test/project',
      image: 'node:22',
      config,
    });

    expect(args).toContain('create');
    expect(args).toContain('macdc-project-abc');
    expect(args).toContain('--mount');
    expect(args).toContain(
      'type=bind,source=/Users/test/project,target=/workspaces/project',
    );
    expect(args).toContain('--cpus');
    expect(args.slice(args.indexOf('--cpus'), args.indexOf('--cpus') + 2)).toEqual([
      '--cpus',
      '4',
    ]);
    expect(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 2)).toEqual([
      '--memory',
      '1G',
    ]);
    expect(args).toContain('--entrypoint');
    expect(args).toContain(CONTAINER_INIT_COMMAND);
    expect(args.at(-1)).toBe(CONTAINER_INIT_COMMAND);
  });

  it('uses hostRequirements overrides', () => {
    const args = buildCreateArgs({
      containerName: 'macdc-project-abc',
      workspaceRoot: '/Users/test/project',
      image: 'node:22',
      config: {
        ...config,
        hostRequirements: { cpus: 2, memory: '4096MB' },
      },
    });

    expect(args.slice(args.indexOf('--cpus'), args.indexOf('--cpus') + 2)).toEqual([
      '--cpus',
      '2',
    ]);
    expect(args.slice(args.indexOf('--memory'), args.indexOf('--memory') + 2)).toEqual([
      '--memory',
      '4096M',
    ]);
  });

  it('rejects paths that would inject fields into the mount specification', () => {
    expect(() =>
      buildCreateArgs({
        containerName: 'macdc-project-abc',
        workspaceRoot: '/Users/test/proj,target=/etc',
        image: 'node:22',
        config,
      }),
    ).toThrow(/comma/);

    expect(() =>
      buildCreateArgs({
        containerName: 'macdc-project-abc',
        workspaceRoot: '/Users/test/project',
        image: 'node:22',
        config: { ...config, workspaceFolder: '/a,ro' },
      }),
    ).toThrow(/comma/);
  });
});

describe('buildExecArgs', () => {
  it('places exec options before the container and keeps command flags intact', () => {
    const args = buildExecArgs('macdc-project-abc', ['sh', '-c', 'echo hello'], {
      user: 'root',
      workdir: '/workspaces/project',
      env: { FOO: 'bar' },
    });

    expect(args).toEqual([
      'exec',
      '--user',
      'root',
      '--workdir',
      '/workspaces/project',
      '--env',
      'FOO=bar',
      'macdc-project-abc',
      'sh',
      '-c',
      'echo hello',
    ]);
  });
});

describe('buildMachineRunArgs', () => {
  it('runs a command as the machine user with an explicit separator', () => {
    const args = buildMachineRunArgs('dev', ['sh', '-c', 'echo hello'], {
      workdir: '/Users/test/project',
    });

    expect(args).toEqual([
      'machine',
      'run',
      '--name',
      'dev',
      '--workdir',
      '/Users/test/project',
      '--',
      'sh',
      '-c',
      'echo hello',
    ]);
  });

  it('maps root and user options correctly', () => {
    expect(buildMachineRunArgs('dev', ['id'], { root: true })).toContain('--root');
    expect(buildMachineRunArgs('dev', ['id'], { user: 'root' })).toContain('--root');
    expect(buildMachineRunArgs('dev', ['id'], { user: 'alice' })).toEqual([
      'machine',
      'run',
      '--name',
      'dev',
      '--user',
      'alice',
      '--',
      'id',
    ]);
  });

  it('passes environment variables before the separator', () => {
    const args = buildMachineRunArgs('dev', ['env'], { env: { FOO: 'bar' } });
    expect(args.slice(0, 6)).toEqual(['machine', 'run', '--name', 'dev', '--env', 'FOO=bar']);
    expect(args.at(-2)).toBe('--');
  });
});

describe('lifecycleSteps', () => {
  it('flattens strings, arrays, and objects in order', () => {
    expect(lifecycleSteps('npm install', 'postCreateCommand')).toEqual([
      { label: 'postCreateCommand', command: 'npm install' },
    ]);

    expect(lifecycleSteps(['one', 'two'], 'postStartCommand')).toEqual([
      { label: 'postStartCommand[0]', command: 'one' },
      { label: 'postStartCommand[1]', command: 'two' },
    ]);

    expect(
      lifecycleSteps({ build: 'make', test: ['a', 'b'] }, 'postCreateCommand'),
    ).toEqual([
      { label: 'postCreateCommand.build', command: 'make' },
      { label: 'postCreateCommand.test[0]', command: 'a' },
      { label: 'postCreateCommand.test[1]', command: 'b' },
    ]);
  });

  it('returns no steps for an absent command', () => {
    expect(lifecycleSteps(undefined, 'postCreateCommand')).toEqual([]);
  });
});

describe('normalizeMemory', () => {
  it('normalizes common suffixes', () => {
    expect(normalizeMemory('4GB')).toBe('4G');
    expect(normalizeMemory('4096MB')).toBe('4096M');
    expect(normalizeMemory('1GiB')).toBe('1G');
    expect(normalizeMemory('512m')).toBe('512M');
  });

  it('rejects invalid values', () => {
    expect(() => normalizeMemory('4')).toThrow(/Invalid memory/);
    expect(() => normalizeMemory('lots')).toThrow(/Invalid memory/);
    expect(() => normalizeMemory('4XB')).toThrow(/Invalid memory/);
  });
});
