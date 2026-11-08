import * as vscode from 'vscode';
import type { Logger } from './util/logger';

export class OutputLogger implements Logger {
  constructor(private readonly channel: vscode.OutputChannel) {}

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[warn] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[error] ${message}`);
  }

  show(): void {
    this.channel.show(true);
  }
}
