import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ForwardPort {
  localPort: number;
  remotePort: number;
}

export interface SshHostEntry {
  host: string;
  hostName: string;
  user: string;
  identityFile: string;
  forwardPorts?: readonly (number | string)[];
}

const FORWARD_PORT_PATTERN = /^(\d+)(?::(\d+))?$/;

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
  const lines = [
    beginMarker(entry.host),
    '# Managed by the macdevcontainer VS Code extension. Do not edit this block.',
    `Host ${entry.host}`,
    `    HostName ${entry.hostName}`,
    `    User ${entry.user}`,
    `    IdentityFile ${quoteSshValue(entry.identityFile)}`,
    '    IdentitiesOnly yes',
    '    StrictHostKeyChecking no',
    '    UserKnownHostsFile /dev/null',
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

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
