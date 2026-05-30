import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export function registerServerCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
  restartFn: () => Promise<void>,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.restartServer', async () => {
      logger.info('Restarting language server...');
      await restartFn();
    }),
    vscode.commands.registerCommand('gsharp.openOutput', () => {
      logger.show();
    }),
  );
}
