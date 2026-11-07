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
            return host.trim();
          }
        }
      }
    } catch {
      // Not encoded JSON; fall through to the plain alias.
    }
  }

  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
