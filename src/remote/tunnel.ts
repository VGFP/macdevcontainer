import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserError, outputTail } from '../util/errors';
import type { Logger } from '../util/logger';
import { canConnect, getFreePort, waitForTcp } from '../util/net';
import { delay } from '../util/process';

export interface StartTunnelOptions {
  projectId: string;
  sshHost: string;
  sshConfigFile: string;
  containerIp: string;
  logger: Logger;
}

export interface TunnelInfo {
  port: number;
}

interface TunnelState {
  pid: number;
  port: number;
  containerIp: string;
  sshHost: string;
}

const TUNNEL_DIRECTORY = join(homedir(), '.macdevcontainer', 'tunnels');
const LOG_DIRECTORY = join(homedir(), '.macdevcontainer', 'logs');

/**
 * Open a local SSH tunnel through the existing Remote-SSH host:
 * 127.0.0.1:<port> -> <remote host> -> <containerIp>:22
 *
 * The tunnel process is detached so it survives the extension host and can be
 * used by the Remote-SSH window that is about to open.
 */
export async function startSshTunnel(options: StartTunnelOptions): Promise<TunnelInfo> {
  const statePath = stateFile(options.projectId);
  const existing = await readState(statePath);

  if (
    existing &&
    existing.containerIp === options.containerIp &&
    existing.sshHost === options.sshHost &&
    isAlive(existing.pid) &&
    (await canConnect('127.0.0.1', existing.port, 1000))
  ) {
    options.logger.info(`Reusing SSH tunnel on 127.0.0.1:${existing.port}.`);
    return { port: existing.port };
  }

  await stopSshTunnel(options.projectId);

  const port = await getFreePort('127.0.0.1');
  const logPath = join(LOG_DIRECTORY, `tunnel-${options.projectId}.log`);
  await mkdir(LOG_DIRECTORY, { recursive: true, mode: 0o700 });

  const logHandle = await open(logPath, 'a');
  await logHandle.write(
    `\n[${new Date().toISOString()}] ${options.sshHost} -> ${options.containerIp}:22 on 127.0.0.1:${port}\n`,
  );

  const args = [
    '-N',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ConnectTimeout=10',
    '-F',
    options.sshConfigFile,
    '-L',
    `127.0.0.1:${port}:${options.containerIp}:22`,
    options.sshHost,
  ];

  options.logger.info(`$ ssh ${args.join(' ')}`);
  const child = spawn('ssh', args, {
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();

  await writeState(statePath, {
    pid: child.pid ?? -1,
    port,
    containerIp: options.containerIp,
    sshHost: options.sshHost,
  });

  try {
    await waitForTcp('127.0.0.1', port, 20_000);
  } catch (error) {
    const log = await tailLog(logPath);
    await stopSshTunnel(options.projectId);
    throw new UserError(
      `Could not open an SSH tunnel to the container at ${options.containerIp}:22.`,
      [outputTail(log), error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  return { port };
}

/** Stop the tunnel for a project, if one is running. */
export async function stopSshTunnel(projectId: string): Promise<void> {
  const path = stateFile(projectId);
  const state = await readState(path);
  if (!state) {
    return;
  }

  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!isAlive(state.pid)) {
        break;
      }
      await delay(100);
    }
    if (isAlive(state.pid)) {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // Best effort.
      }
    }
  }

  await rm(path, { force: true });
}

function stateFile(projectId: string): string {
  return join(TUNNEL_DIRECTORY, `${projectId}.json`);
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState(path: string): Promise<TunnelState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) {
      return undefined;
    }
    const { pid, port, containerIp, sshHost } = parsed;
    if (
      typeof pid === 'number' &&
      typeof port === 'number' &&
      typeof containerIp === 'string' &&
      typeof sshHost === 'string'
    ) {
      return { pid, port, containerIp, sshHost };
    }
  } catch {
    // Missing or corrupt state; treat as no tunnel.
  }
  return undefined;
}

async function writeState(path: string, state: TunnelState): Promise<void> {
  await mkdir(TUNNEL_DIRECTORY, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

async function tailLog(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
