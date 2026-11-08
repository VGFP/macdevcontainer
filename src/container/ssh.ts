import { UserError, outputTail } from '../util/errors';
import type { Logger } from '../util/logger';
import type { RunResult } from '../util/process';
import type { ExecOptions } from './args';

/**
 * A place where commands can be executed: a container or a container machine.
 * Both use the same SSH bootstrap scripts.
 */
export interface CommandTarget {
  label: string;
  /** Run a POSIX shell script in the target. */
  shell(script: string, options?: ExecOptions & { timeoutMs?: number }): Promise<RunResult>;
}

const LOCATE_SSHD = [
  'if command -v sshd >/dev/null 2>&1; then',
  '  command -v sshd',
  'elif [ -x /usr/sbin/sshd ]; then',
  '  echo /usr/sbin/sshd',
  'elif [ -x /usr/local/sbin/sshd ]; then',
  '  echo /usr/local/sbin/sshd',
  'else',
  '  exit 42',
  'fi',
].join('\n');

/** Install OpenSSH using whichever package manager the image provides. */
export const SSHD_INSTALL_SCRIPT = [
  'set -e',
  'if command -v apt-get >/dev/null 2>&1; then',
  '  export DEBIAN_FRONTEND=noninteractive',
  '  apt-get update',
  '  apt-get install -y openssh-server',
  'elif command -v apk >/dev/null 2>&1; then',
  '  apk add --no-cache openssh',
  'elif command -v dnf >/dev/null 2>&1; then',
  '  dnf install -y openssh-server',
  'elif command -v yum >/dev/null 2>&1; then',
  '  yum install -y openssh-server',
  'elif command -v pacman >/dev/null 2>&1; then',
  '  pacman -Sy --noconfirm openssh',
  'else',
  '  echo "No supported package manager found (apt-get, apk, dnf, yum, pacman)." >&2',
  '  exit 42',
  'fi',
].join('\n');

export function buildInstallKeyScript(
  remoteUser: string,
  publicKey: string,
  projectId: string,
): string {
  return [
    'set -e',
    `u=${quoteShell(remoteUser)}`,
    `key=${quoteShell(publicKey)}`,
    `pattern=${quoteShell(`macdevcontainer:${projectId}`)}`,
    'home=""',
    'if command -v getent >/dev/null 2>&1; then',
    '  home="$(getent passwd "$u" 2>/dev/null | cut -d: -f6 || true)"',
    'fi',
    'if [ -z "$home" ] && [ -r /etc/passwd ]; then',
    '  home="$(awk -F: -v u="$u" \'$1==u || $3==u { print $6; exit }\' /etc/passwd)"',
    'fi',
    'if [ -z "$home" ]; then',
    '  echo "No home directory found for user \'$u\'." >&2',
    '  exit 3',
    'fi',
    'mkdir -p "$home/.ssh"',
    'chmod 700 "$home/.ssh"',
    'touch "$home/.ssh/authorized_keys"',
    'grep -v "$pattern" "$home/.ssh/authorized_keys" > "$home/.ssh/authorized_keys.macdc" || true',
    'printf \'%s\\n\' "$key" >> "$home/.ssh/authorized_keys.macdc"',
    'mv "$home/.ssh/authorized_keys.macdc" "$home/.ssh/authorized_keys"',
    'chmod 600 "$home/.ssh/authorized_keys"',
    'chown -R "$u" "$home/.ssh" 2>/dev/null || true',
  ].join('\n');
}

/**
 * Container machines create the guest account locked (a "!" password hash).
 * OpenSSH refuses every login for a locked account, including public-key auth.
 * Replace only the lock marker with an unusable "x" hash: key auth then works
 * while password auth remains impossible.
 */
export async function unlockAccount(target: CommandTarget, user: string): Promise<void> {
  const script = [
    'set -e',
    `u=${quoteShell(user)}`,
    'if [ -r /etc/shadow ]; then',
    `  awk -F: -v u="$u" 'BEGIN { OFS=":" } $1 == u && ($2 ~ /^[!*]/) { $2 = "x" } { print }' /etc/shadow > /etc/shadow.macdc`,
    '  cat /etc/shadow.macdc > /etc/shadow',
    '  rm -f /etc/shadow.macdc',
    'fi',
  ].join('\n');

  const result = await target.shell(script, { user: 'root', timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new UserError(
      `Could not unlock the SSH account "${user}" in ${target.label}.`,
      outputTail(result.stderr || result.stdout),
    );
  }
}

/** Ensure sshd is present and available on port 22 inside the target. */
export async function ensureSshd(target: CommandTarget, logger: Logger): Promise<void> {
  let sshdPath = await locateSshd(target);

  if (!sshdPath) {
    logger.warn(
      `OpenSSH is not installed in ${target.label}. Installing openssh-server...`,
    );
    const installed = await target.shell(SSHD_INSTALL_SCRIPT, {
      user: 'root',
      timeoutMs: 10 * 60 * 1000,
    });

    if (installed.code !== 0) {
      throw new UserError(
        'OpenSSH is not installed and could not be installed automatically.',
        [
          outputTail(installed.stderr || installed.stdout),
          'Add openssh-server to the image, or install it from postCreateCommand.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    sshdPath = await locateSshd(target);
    if (!sshdPath) {
      throw new UserError(
        'OpenSSH was installed but the sshd executable could not be found.',
        'Check the image package layout and ensure /usr/sbin/sshd exists.',
      );
    }
  }

  logger.info(`Starting sshd (${sshdPath}) in ${target.label}...`);

  const startScript = [
    'set -e',
    `export SSHD=${quoteShell(sshdPath)}`,
    'mkdir -p /run/sshd',
    'ssh-keygen -A >/dev/null 2>&1 || true',
    '"$SSHD" -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no -o PubkeyAuthentication=yes -o UsePAM=no >/dev/null 2>&1 || true',
  ].join('\n');

  const started = await target.shell(startScript, {
    user: 'root',
    timeoutMs: 60_000,
  });

  if (started.code !== 0) {
    throw new UserError(
      `Could not start sshd in ${target.label}.`,
      outputTail(started.stderr || started.stdout),
    );
  }
}

async function locateSshd(target: CommandTarget): Promise<string | undefined> {
  const located = await target.shell(LOCATE_SSHD, {
    user: 'root',
    timeoutMs: 30_000,
  });

  if (located.code !== 0) {
    return undefined;
  }

  return (
    located.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() || undefined
  );
}

/**
 * Add (or replace) the public key in the remote user's authorized_keys. The
 * key comment carries the project id so repeated runs do not accumulate keys.
 */
export async function installAuthorizedKey(
  target: CommandTarget,
  remoteUser: string,
  publicKey: string,
  projectId: string,
): Promise<void> {
  const result = await target.shell(
    buildInstallKeyScript(remoteUser, publicKey, projectId),
    { user: 'root', timeoutMs: 30_000 },
  );

  if (result.code !== 0) {
    throw new UserError(
      `Could not install the SSH key for user "${remoteUser}" in ${target.label}.`,
      outputTail(result.stderr || result.stdout),
    );
  }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
