import * as vscode from 'vscode';

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    (error.code === 'FileNotFound' || error.code === 'EntryNotFound')
  );
}

/**
 * Find devcontainer files through the VS Code file system API so this works
 * for both local folders and folders on a Remote-SSH host.
 */
export async function findDevContainerUris(root: vscode.Uri): Promise<vscode.Uri[]> {
  const candidates: vscode.Uri[] = [];

  const primary = vscode.Uri.joinPath(root, '.devcontainer', 'devcontainer.json');
  if (await exists(primary)) {
    candidates.push(primary);
  }

  const single = vscode.Uri.joinPath(root, '.devcontainer.json');
  if (await exists(single)) {
    candidates.push(single);
  }

  const containerDirectory = vscode.Uri.joinPath(root, '.devcontainer');
  try {
    const entries = await vscode.workspace.fs.readDirectory(containerDirectory);
    entries.sort((left, right) => left[0].localeCompare(right[0]));
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const file = vscode.Uri.joinPath(containerDirectory, name, 'devcontainer.json');
      if (await exists(file)) {
        candidates.push(file);
      }
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  const unique = new Map<string, vscode.Uri>();
  for (const uri of candidates) {
    unique.set(uri.toString(), uri);
  }
  return [...unique.values()];
}

export async function readWorkspaceText(uri: vscode.Uri): Promise<string> {
  const data = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder().decode(data);
}

export function uriLabel(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.path;
}
