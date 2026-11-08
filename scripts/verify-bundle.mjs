import { readFile } from 'node:fs/promises';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bundlePath = new URL('../dist/extension.js', import.meta.url);
const source = await readFile(bundlePath, 'utf8');

const unbundled = [
  ...source.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g),
].map((match) => match[2]);
if (unbundled.length > 0) {
  console.error('Bundle contains unbundled relative requires:');
  for (const item of unbundled) {
    console.error(`  ${item}`);
  }
  process.exit(1);
}

const commands = new Map();
const output = { appendLine() {}, show() {}, dispose() {} };
const vscode = {
  window: {
    createOutputChannel: () => output,
    registerUriHandler: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_options, task) => task({ report() {} }),
    showQuickPick: async () => undefined,
  },
  commands: {
    registerCommand: (id, callback) => {
      commands.set(id, callback);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
  extensions: { getExtension: () => ({}) },
  env: { remoteName: undefined, uriScheme: 'vscode' },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    workspaceFolders: [],
    asRelativePath: (value) => String(value),
    fs: {},
  },
  Uri: {
    parse: (value) => ({ toString: () => value }),
    joinPath: (...parts) => ({ toString: () => parts.join('/') }),
  },
  ProgressLocation: { Notification: 15 },
  FileType: { Directory: 2 },
  FileSystemError: class extends Error {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require(bundlePath.pathname);
  const context = { subscriptions: [] };
  extension.activate(context);

  const expected = [
    'macdevcontainer.reopenInContainer',
    'macdevcontainer.rebuildContainer',
    'macdevcontainer.reopenInMachine',
    'macdevcontainer.forgetMachine',
    'macdevcontainer.removeContainer',
    'macdevcontainer.showLog',
  ];
  for (const command of expected) {
    if (!commands.has(command)) {
      throw new Error(`Command was not registered: ${command}`);
    }
  }
  if (typeof extension.deactivate === 'function') {
    extension.deactivate();
  }

  console.log(`Bundle OK: ${expected.length} commands registered.`);
} finally {
  Module._load = originalLoad;
}
