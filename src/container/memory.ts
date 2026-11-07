import { UserError } from '../util/errors';

const MEMORY_PATTERN = /^(\d+(?:\.\d+)?)\s*([KMGTP])(?:i?B)?$/i;

/**
 * Normalize a Dev Containers memory string such as "4GB" or "4096MiB" to the
 * suffix format accepted by the Apple container CLI.
 */
export function normalizeMemory(value: string): string {
  const match = MEMORY_PATTERN.exec(value.trim());
  if (!match) {
    throw new UserError(
      `Invalid memory value "${value}". Use a value such as "4GB" or "4096MB".`,
    );
  }
  const amount = match[1]!;
  const unit = match[2]!.toUpperCase();
  return `${amount}${unit}`;
}
