import { UserError, outputTail } from '../util/errors';
import { run } from '../util/process';

/** Verify that key-based SSH authentication to the configured host works. */
export async function verifySsh(host: string, sshConfigFile: string): Promise<void> {
  const result = await run(
    'ssh',
    [
      '-F',
      sshConfigFile,
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      host,
      'true',
    ],
    { timeoutMs: 20_000 },
  );

  if (result.code !== 0) {
    throw new UserError(
      `Could not connect to the container over SSH as "${host}".`,
      outputTail(result.stderr || result.stdout),
    );
  }
}
