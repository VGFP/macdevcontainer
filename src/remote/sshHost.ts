/**
 * Extract the SSH config host alias from a Remote-SSH authority.
 *
 * Remote-SSH uses either a plain alias (`ssh-remote+my-mac`) or a hex-encoded
 * JSON object (`ssh-remote+7b22686f73744e616d65223a...`).
 */
export function parseSshRemoteHost(remoteName: string | undefined): string | undefined {
  if (!remoteName || !remoteName.startsWith('ssh-remote+')) {
    return undefined;
  }

  const encoded = remoteName.slice('ssh-remote+'.length).split('@')[0];
  if (!encoded) {
    return undefined;
  }

  if (/^[0-9a-f]+$/i.test(encoded) && encoded.length % 2 === 0) {
    try {
      const decoded = Buffer.from(encoded, 'hex').toString('utf8');
      if (decoded.startsWith('{')) {
        const parsed: unknown = JSON.parse(decoded);
        if (isRecord(parsed)) {
          const host = parsed.hostName ?? parsed.host ?? parsed.hostname;
          if (typeof host === 'string' && host.trim().length > 0) {
            return safeHostAlias(host.trim());
          }
        }
      }
    } catch {
      // Not encoded JSON; fall through to the plain alias.
    }
  }

  return safeHostAlias(encoded);
}

/**
 * The alias is passed to ssh as a single argument; anything starting with "-"
 * would be parsed as an option, so only plain tokens are accepted.
 */
function safeHostAlias(alias: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias) ? alias : undefined;
}

/**
 * Resolve the SSH host for the current window.
 *
 * In a local UI extension attached to a remote window, `vscode.env.remoteName`
 * is only the remote type (`ssh-remote`). The host authority lives in the
 * workspace folder URI (`vscode-remote://ssh-remote+.../path`).
 */
export function resolveSshRemoteHost(
  remoteName: string | undefined,
  workspaceUriAuthority: string | undefined,
): string | undefined {
  if (workspaceUriAuthority && workspaceUriAuthority.startsWith('ssh-remote+')) {
    return parseSshRemoteHost(workspaceUriAuthority);
  }
  return parseSshRemoteHost(remoteName);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
