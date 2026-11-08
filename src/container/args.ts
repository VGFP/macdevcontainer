import type { DevContainerConfig, LifecycleCommand } from '../devcontainer/types';
import { normalizeMemory } from './memory';

export const CONTAINER_LABEL = 'com.vgfp.macdevcontainer';

/** Defaults match the documented behaviour: 4 vCPUs and 1 GiB of memory. */
export const DEFAULT_CPUS = 4;
export const DEFAULT_MEMORY = '1G';

export const CONTAINER_INIT_COMMAND = 'while :; do sleep 3600; done';

export interface CreateContainerOptions {
  containerName: string;
  workspaceRoot: string;
  image: string;
  config: DevContainerConfig;
}

/** Arguments for `container create`, excluding the leading `container` binary. */
export function buildCreateArgs(options: CreateContainerOptions): string[] {
  const { config } = options;
  return [
    'create',
    '--name',
    options.containerName,
    '--label',
    `${CONTAINER_LABEL}=1`,
    '--mount',
    `type=bind,source=${options.workspaceRoot},target=${config.workspaceFolder}`,
    '--workdir',
    config.workspaceFolder,
    '--cpus',
    String(config.hostRequirements.cpus ?? DEFAULT_CPUS),
    '--memory',
    normalizeMemory(config.hostRequirements.memory ?? DEFAULT_MEMORY),
    '--entrypoint',
    '/bin/sh',
    options.image,
    '-c',
    CONTAINER_INIT_COMMAND,
  ];
}

export interface ExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
}

/** Arguments for `container exec`, excluding the leading `container` binary. */
export function buildExecArgs(
  containerName: string,
  command: readonly string[],
  options: ExecOptions = {},
): string[] {
  const args = ['exec'];
  if (options.user) {
    args.push('--user', options.user);
  }
  if (options.workdir) {
    args.push('--workdir', options.workdir);
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(containerName, ...command);
  return args;
}

export interface LifecycleStep {
  label: string;
  command: string;
}

/** Flatten the supported lifecycle command shapes into ordered steps. */
export function lifecycleSteps(
  command: LifecycleCommand | undefined,
  key: string,
): LifecycleStep[] {
  if (command === undefined) {
    return [];
  }
  if (typeof command === 'string') {
    return [{ label: key, command }];
  }
  if (Array.isArray(command)) {
    return command.map((entry, index) => ({
      label: `${key}[${index}]`,
      command: entry,
    }));
  }
  return Object.entries(command).flatMap(([name, value]) => {
    if (Array.isArray(value)) {
      return value.map((entry, index) => ({
        label: `${key}.${name}[${index}]`,
        command: entry,
      }));
    }
    return [{ label: `${key}.${name}`, command: value }];
  });
}
