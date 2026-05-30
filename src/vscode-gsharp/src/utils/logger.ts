import * as vscode from 'vscode';

export class Logger {
  private readonly outputChannel: vscode.LogOutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('GSharp', { log: true });
  }

  info(message: string) {
    this.outputChannel.info(message);
  }

  warn(message: string) {
    this.outputChannel.warn(message);
  }

  error(message: string, err?: unknown) {
    if (err instanceof Error) {
      this.outputChannel.error(`${message}: ${err.message}`);
    } else {
      this.outputChannel.error(message);
    }
  }

  show() {
    this.outputChannel.show();
  }

  dispose() {
    this.outputChannel.dispose();
  }
}
