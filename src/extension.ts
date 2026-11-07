import * as vscode from 'vscode';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('macdevcontainer');
  context.subscriptions.push(output);
  registerCommands(context, output);
  output.appendLine('[info] macdevcontainer activated.');
}

export function deactivate(): void {
  // Nothing to dispose: all disposables are registered on the extension context.
}
