import { posix } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { UserError } from '../util/errors';
import type {
  DevContainerConfig,
  HostRequirements,
  LifecycleCommand,
  ParsedDevContainer,
} from './types';

/** Keys documented as not implemented yet. */
const UNSUPPORTED_KEYS: Readonly<Record<string, string>> = {
  build: 'Dockerfile-based builds are not implemented yet',
  mounts: 'additional mounts are not implemented yet',
  features: 'Dev Container Features are not implemented yet',
  containerEnv: 'containerEnv is not implemented yet',
  runArgs: 'extra run arguments are not implemented yet',
};

const FORWARD_PORT_PATTERN = /^(\d+)(?::(\d+))?$/;

export interface ParseDevContainerOptions {
  /**
   * Container machines already provide the image, so a configuration without
   * `image` (or with only `build`) is valid when opening in a machine.
   */
  requireImage?: boolean;
}

export function parseDevContainer(
  text: string,
  filePath: string,
  workspaceRoot: string,
  options: ParseDevContainerOptions = {},
): ParsedDevContainer {
  const errors: ParseError[] = [];
  const data: unknown = parse(stripBom(text), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const first = errors[0];
    if (!first) {
      throw new UserError(`Cannot parse ${filePath}.`);
    }
    throw new UserError(
      `Cannot parse ${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}.`,
    );
  }

  if (!isRecord(data)) {
    throw new UserError(`Expected ${filePath} to contain a JSON object.`);
  }

  const warnings = Object.entries(UNSUPPORTED_KEYS)
    .filter(([key]) => data[key] !== undefined)
    .map(([key, reason]) => `"${key}" is not supported yet and is ignored (${reason}).`);

  const image = optionalString(data.image, 'image', filePath);
  if (!image && options.requireImage !== false) {
    if (data.build !== undefined) {
      throw new UserError(
        'Dockerfile-based builds ("build") are not supported yet. Use "image" for now.',
      );
    }
    throw new UserError(`"image" is required in ${filePath}.`);
  }

  const remoteUser = optionalString(data.remoteUser, 'remoteUser', filePath) ?? 'root';
  const workspaceFolder = normalizeContainerPath(
    optionalString(data.workspaceFolder, 'workspaceFolder', filePath) ??
      `/workspaces/${posix.basename(workspaceRoot) || 'workspace'}`,
    'workspaceFolder',
    filePath,
  );

  const hostRequirements = parseHostRequirements(data.hostRequirements, filePath);
  const forwardPorts = parseForwardPorts(data.forwardPorts, filePath);
  const postCreateCommand = parseLifecycleCommand(
    data.postCreateCommand,
    'postCreateCommand',
    filePath,
  );
  const postStartCommand = parseLifecycleCommand(
    data.postStartCommand,
    'postStartCommand',
    filePath,
  );

  const config: DevContainerConfig = {
    image: image ?? '',
    remoteUser,
    workspaceFolder,
    forwardPorts,
    hostRequirements,
  };

  const name = optionalString(data.name, 'name', filePath);
  if (name) {
    config.name = name;
  }
  if (postCreateCommand) {
    config.postCreateCommand = postCreateCommand;
  }
  if (postStartCommand) {
    config.postStartCommand = postStartCommand;
  }

  return { config, warnings };
}

function parseHostRequirements(value: unknown, filePath: string): HostRequirements {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new UserError(`"hostRequirements" in ${filePath} must be an object.`);
  }

  const requirements: HostRequirements = {};
  if (value.cpus !== undefined) {
    if (typeof value.cpus !== 'number' || !Number.isFinite(value.cpus) || value.cpus <= 0) {
      throw new UserError(`"hostRequirements.cpus" in ${filePath} must be a positive number.`);
    }
    requirements.cpus = value.cpus;
  }
  if (value.memory !== undefined) {
    if (typeof value.memory !== 'string' || value.memory.trim().length === 0) {
      throw new UserError(`"hostRequirements.memory" in ${filePath} must be a non-empty string.`);
    }
    requirements.memory = value.memory.trim();
  }
  return requirements;
}

function parseForwardPorts(value: unknown, filePath: string): Array<number | string> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new UserError(`"forwardPorts" in ${filePath} must be an array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry === 'number') {
      assertPort(entry, `forwardPorts[${index}]`, filePath);
      return entry;
    }
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      const match = FORWARD_PORT_PATTERN.exec(trimmed);
      if (!match) {
        throw new UserError(
          `"forwardPorts[${index}]" in ${filePath} must be a port number or "host:container" string.`,
        );
      }
      assertPort(Number(match[1]), `forwardPorts[${index}]`, filePath);
      if (match[2] !== undefined) {
        assertPort(Number(match[2]), `forwardPorts[${index}]`, filePath);
      }
      return trimmed;
    }
    throw new UserError(
      `"forwardPorts[${index}]" in ${filePath} must be a port number or "host:container" string.`,
    );
  });
}

function parseLifecycleCommand(
  value: unknown,
  key: string,
  filePath: string,
): LifecycleCommand | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return requireCommand(value, key, filePath);
  }
  if (Array.isArray(value)) {
    return value.map((command, index) =>
      requireCommand(command, `${key}[${index}]`, filePath),
    );
  }
  if (isRecord(value)) {
    const commands: Record<string, string | string[]> = {};
    for (const [name, command] of Object.entries(value)) {
      if (Array.isArray(command)) {
        commands[name] = command.map((entry, index) =>
          requireCommand(entry, `${key}.${name}[${index}]`, filePath),
        );
      } else {
        commands[name] = requireCommand(command, `${key}.${name}`, filePath);
      }
    }
    return commands;
  }
  throw new UserError(
    `"${key}" in ${filePath} must be a string, an array of strings, or an object of commands.`,
  );
}

function requireCommand(value: unknown, key: string, filePath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UserError(`"${key}" in ${filePath} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, key: string, filePath: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new UserError(`"${key}" in ${filePath} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeContainerPath(value: string, key: string, filePath: string): string {
  if (!value.startsWith('/')) {
    throw new UserError(`"${key}" in ${filePath} must be an absolute container path.`);
  }
  if (value.includes('\0')) {
    throw new UserError(`"${key}" in ${filePath} must not contain NUL characters.`);
  }
  const normalized = value.replace(/\/+$/, '') || '/';
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) {
    throw new UserError(`"${key}" in ${filePath} must not contain ".." segments.`);
  }
  if (normalized === '/') {
    throw new UserError(`"${key}" in ${filePath} must not be the container root.`);
  }
  return normalized;
}

function assertPort(port: number, key: string, filePath: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError(`"${key}" in ${filePath} must be a TCP port between 1 and 65535.`);
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
