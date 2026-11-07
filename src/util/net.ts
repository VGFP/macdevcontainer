import { createServer, connect } from 'node:net';
import { UserError } from './errors';

/** Wait until a TCP port is reachable. */
export function waitForTcp(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const attempt = (): void => {
      if (settled) {
        return;
      }

      const socket = connect({ host, port });

      const finish = (error?: Error): void => {
        socket.removeAllListeners();
        socket.destroy();
        if (settled) {
          return;
        }
        if (!error) {
          settled = true;
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          settled = true;
          reject(
            new UserError(
              `Port ${port} on ${host} did not become reachable.`,
              error.message,
            ),
          );
          return;
        }
        setTimeout(attempt, 500).unref();
      };

      socket.setTimeout(2000);
      socket.once('connect', () => finish());
      socket.once('timeout', () => finish(new Error('Connection timed out.')));
      socket.once('error', (error) => finish(error));
    };

    attempt();
  });
}

/** Check a TCP port once. */
export function canConnect(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Ask the OS for an unused local port. */
export function getFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new UserError('Could not allocate a local port.')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
