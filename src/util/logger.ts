export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  info(): void {
    // no-op
  },
  warn(): void {
    // no-op
  },
  error(): void {
    // no-op
  },
};

export function logLines(logger: Logger, prefix: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      logger.info(`${prefix}${line}`);
    }
  }
}
