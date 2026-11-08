import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, sep } from 'node:path';
import { fileExists } from './util/fs';

/**
 * Find supported devcontainer configuration files in a workspace:
 * `.devcontainer/devcontainer.json`, `.devcontainer.json`, and
 * `.devcontainer/<name>/devcontainer.json`.
 */
export async function findDevContainerFiles(workspaceRoot: string): Promise<string[]> {
  const candidates: string[] = [];

  const primary = join(workspaceRoot, '.devcontainer', 'devcontainer.json');
  if (await fileExists(primary)) {
    candidates.push(primary);
  }

  const single = join(workspaceRoot, '.devcontainer.json');
  if (await fileExists(single)) {
    candidates.push(single);
  }

  const containerDirectory = join(workspaceRoot, '.devcontainer');
  try {
    const entries = await readdir(containerDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const file = join(containerDirectory, entry.name, 'devcontainer.json');
      if (await fileExists(file)) {
        candidates.push(file);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return [...new Set(candidates)];
}

/**
 * Apple container cannot share paths protected by macOS privacy. Detect the
 * common cases before creating a container that would hang.
 */
export function isProtectedWorkspacePath(workspaceRoot: string, home = homedir()): boolean {
  return ['Desktop', 'Documents', 'Downloads'].some((name) => {
    const directory = join(home, name);
    return workspaceRoot === directory || workspaceRoot.startsWith(directory + sep);
  });
}

/** POSIX variant for paths on a remote Mac. */
export function isProtectedPosixWorkspacePath(workspaceRoot: string, home: string): boolean {
  return ['Desktop', 'Documents', 'Downloads'].some((name) => {
    const directory = posix.join(home, name);
    return workspaceRoot === directory || workspaceRoot.startsWith(`${directory}/`);
  });
}
