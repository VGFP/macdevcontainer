import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserError, outputTail } from '../util/errors';
import { fileExists } from '../util/fs';
import { run } from '../util/process';

export interface KeyPair {
  privateKeyPath: string;
  publicKey: string;
}

export function defaultKeyDirectory(home = homedir()): string {
  return join(home, '.macdevcontainer', 'keys');
}

/** Create (or reuse) a per-project Ed25519 key and return its public key. */
export async function ensureKeyPair(
  projectId: string,
  keyDirectory = defaultKeyDirectory(),
): Promise<KeyPair> {
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  await chmod(keyDirectory, 0o700).catch(() => undefined);

  const privateKeyPath = join(keyDirectory, `${projectId}_ed25519`);
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!(await fileExists(privateKeyPath))) {
    const result = await run('ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      `macdevcontainer:${projectId}`,
      '-f',
      privateKeyPath,
    ]);
    if (result.code !== 0) {
      throw new UserError(
        'Could not generate an SSH key for the container.',
        outputTail(result.stderr || result.stdout),
      );
    }
  }

  await chmod(privateKeyPath, 0o600).catch(() => undefined);

  let publicKey = '';
  if (await fileExists(publicKeyPath)) {
    publicKey = (await readFile(publicKeyPath, 'utf8')).trim();
  }

  if (publicKey.length === 0) {
    const result = await run('ssh-keygen', ['-y', '-f', privateKeyPath]);
    if (result.code !== 0) {
      throw new UserError(
        'Could not read the public SSH key for the container.',
        outputTail(result.stderr || result.stdout),
      );
    }
    publicKey = result.stdout.trim();
    await writeFile(publicKeyPath, `${publicKey}\n`, { mode: 0o644 });
    await chmod(publicKeyPath, 0o644).catch(() => undefined);
  }

  if (publicKey.length === 0) {
    throw new UserError('The generated SSH public key is empty.');
  }

  return { privateKeyPath, publicKey };
}
