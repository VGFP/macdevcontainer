import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { UserError } from './errors';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  input?: string;
}

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function appendCapped(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

/**
 * Run a command without a shell. Resolves with the exit code even for non-zero
 * exits; only spawn failures and timeouts reject.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(new UserError(`Failed to start "${command}".`, error instanceof Error ? error.message : String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk);
      options.onStdout?.(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk);
      options.onStderr?.(chunk.toString('utf8'));
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new UserError(`Failed to run "${command}".`, error.message));
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new UserError(
            `"${command}" did not finish within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds.`,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code: code ?? -1, signal });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
