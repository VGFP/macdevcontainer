/** An error with a user-facing message and optional technical detail. */
export class UserError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'UserError';
    this.detail = detail;
  }
}

/** Thrown when the user cancels a picker or confirmation. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep only the most useful tail of command output for an error dialog. */
export function outputTail(text: string, maxLength = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `…${trimmed.slice(-maxLength)}`;
}
