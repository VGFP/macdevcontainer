import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../util/errors';
import { HOST_ALIAS_PATTERN } from './hostkeys';

export interface ForwardPort {
  localPort: number;
  remotePort: number;
}

export interface SshHostEntry {
  host: string;
  hostName: string;
  port?: number;
  user: string;
  identityFile: string;
  forwardPorts?: readonly (number | string)[];
  /** known_hosts alias pinned for this host (see HostKeyAlias in ssh_config). */
  hostKeyAlias: string;
  /** Path to the known_hosts file that holds the pinned host key. */
  knownHostsFile: string;
}

const FORWARD_PORT_PATTERN = /^(\d+)(?::(\d+))?$/;

/**
 * Values that are safe to interpolate as ssh_config arguments. Newlines,
 * leading dashes, and quote characters would allow config injection or
 * option smuggling, so only plain tokens and host names are accepted.
 */
const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:\[\]-]{0,253}$/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]{0,31}\$?$/;
const PATH_PATTERN = /^[A-Za-z0-9_./~:@%+,\- ]+$/;

export function defaultSshConfigPath(home = homedir()): string {
  return join(home, '.ssh', 'config');
}

export function parseForwardPort(value: number | string): ForwardPort | undefined {
  if (typeof value === 'number') {
    return isPort(value) ? { localPort: value, remotePort: value } : undefined;
  }

  const match = FORWARD_PORT_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const localPort = Number(match[1]);
  const remotePort = match[2] === undefined ? localPort : Number(match[2]);
  if (!isPort(localPort) || !isPort(remotePort)) {
    return undefined;
  }
  return { localPort, remotePort };
}

export function forwardPortsToLocalForwards(
  values: readonly (number | string)[] = [],
): ForwardPort[] {
  const seen = new Set<number>();
  const forwards: ForwardPort[] = [];
  for (const value of values) {
    const forward = parseForwardPort(value);
    if (!forward || seen.has(forward.localPort)) {
      continue;
    }
    seen.add(forward.localPort);
    forwards.push(forward);
  }
  return forwards;
}

export function buildManagedSshBlock(entry: SshHostEntry): string {
  validateEntry(entry);
  const lines = [
    beginMarker(entry.host),
    '# Managed by the macdevcontainer VS Code extension. Do not edit this block.',
    `Host ${entry.host}`,
    `    HostName ${entry.hostName}`,
    `    User ${entry.user}`,
    ...(entry.port === undefined ? [] : [`    Port ${entry.port}`]),
    `    IdentityFile ${quoteSshValue(entry.identityFile)}`,
    '    IdentitiesOnly yes',
    '    StrictHostKeyChecking yes',
    `    UserKnownHostsFile ${quoteSshValue(entry.knownHostsFile)}`,
    `    HostKeyAlias ${entry.hostKeyAlias}`,
    '    LogLevel ERROR',
    '    ServerAliveInterval 15',
    '    ServerAliveCountMax 3',
  ];

  for (const forward of forwardPortsToLocalForwards(entry.forwardPorts)) {
    lines.push(`    LocalForward ${forward.localPort} 127.0.0.1:${forward.remotePort}`);
  }

  lines.push(endMarker(entry.host));
  return lines.join('\n');
}

/** Add or replace the managed block for this host without touching other entries. */
export function upsertManagedSshBlock(existing: string, entry: SshHostEntry): string {
  const lines = withoutManagedBlock(existing, entry.host).split('\n');
  const cleaned = trimTrailingBlankLines(lines).join('\n');
  const block = buildManagedSshBlock(entry);
  return `${cleaned.length > 0 ? `${cleaned}\n\n` : ''}${block}\n`;
}

/** Remove the managed block for a host, preserving all other configuration. */
export function removeManagedSshBlock(existing: string, host: string): string {
  const lines = trimTrailingBlankLines(withoutManagedBlock(existing, host).split('\n'));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function withoutManagedBlock(existing: string, host: string): string {
  const normalized = existing.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const begin = beginMarker(host);
  const end = endMarker(host);
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end);

  if (start !== -1 && stop > start) {
    lines.splice(start, stop - start + 1);
  }
  return lines.join('\n');
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1]?.trim() === '') {
    result.pop();
  }
  while (result.length > 0 && result[0]?.trim() === '') {
    result.shift();
  }
  return result;
}

function beginMarker(host: string): string {
  return `# >>> macdevcontainer:${host} >>>`;
}

function endMarker(host: string): string {
  return `# <<< macdevcontainer:${host} <<<`;
}

function quoteSshValue(value: string): string {
  if (/^[A-Za-z0-9_./~:@%+,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Reject values that could break out of the managed block and inject
 * directives into the user's SSH configuration. This is defense in depth:
 * the devcontainer parser already restricts most of these values.
 */
function validateEntry(entry: SshHostEntry): void {
  if (!HOST_ALIAS_PATTERN.test(entry.host)) {
    throw new UserError(`"${entry.host}" is not a valid SSH host alias.`);
  }
  if (!HOST_NAME_PATTERN.test(entry.hostName)) {
    throw new UserError(`"${entry.hostName}" is not a valid SSH host name.`);
  }
  if (!USER_PATTERN.test(entry.user)) {
    throw new UserError(`"${entry.user}" is not a valid SSH user name.`);
  }
  if (!HOST_ALIAS_PATTERN.test(entry.hostKeyAlias)) {
    throw new UserError(`"${entry.hostKeyAlias}" is not a valid host key alias.`);
  }
  if (!PATH_PATTERN.test(entry.knownHostsFile) || !entry.knownHostsFile.startsWith('/')) {
    throw new UserError('The known_hosts path must be an absolute path without quotes.');
  }
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
