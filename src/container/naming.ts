import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** Stable identifier for a workspace, used for container names and SSH keys. */
export function projectId(workspaceRoot: string): string {
  return createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
}

export function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Deterministic container name for a workspace. */
export function containerNameForWorkspace(workspaceRoot: string): string {
  const base = sanitizeName(basename(workspaceRoot)).slice(0, 24).replace(/[-_.]+$/, '');
  return `macdc-${base || 'workspace'}-${projectId(workspaceRoot).slice(0, 10)}`;
}
