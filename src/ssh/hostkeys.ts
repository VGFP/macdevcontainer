import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserError } from '../util/errors';

/** A public host key line without the leading host field. */
const HOST_KEY_PATTERN =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{40,}={0,3}( .+)?$/;

/** Host aliases written to known_hosts must be plain tokens. */
export const HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function defaultKnownHostsFile(home = homedir()): string {
  return join(home, '.macdevcontainer', 'known_hosts');
}

/** Accept only a single, well-formed public host key line. */
export function isValidHostKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    return false;
  }
  return HOST_KEY_PATTERN.test(trimmed);
}

/**
 * Replace (or add) the known_hosts entry for an alias, preserving all other
 * lines. Entries are keyed by the HostKeyAlias pinned in the managed SSH
 * config block, so the entry stays valid when the container IP or tunnel
 * port changes.
 */
export function updateKnownHostsEntry(existing: string, alias: string, hostKey: string): string {
  if (!HOST_ALIAS_PATTERN.test(alias)) {
    throw new UserError(`"${alias}" is not a valid host alias for known_hosts.`);
  }
  if (!isValidHostKey(hostKey)) {
    throw new UserError('The SSH host key could not be read or is malformed.');
  }

  const kept = existing
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0 && !knownHostsLineMatches(line, alias));

  kept.push(`${alias} ${hostKey.trim()}`);
  return `${kept.join('\n')}\n`;
}

function knownHostsLineMatches(line: string, alias: string): boolean {
  const hostField = line.trim().split(/\s+/)[0] ?? '';
  // A comma-separated host field matches when any of its entries is the alias.
  return hostField.split(',').includes(alias);
}
