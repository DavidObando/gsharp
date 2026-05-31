import * as vscode from 'vscode';
import { ServerManager } from './server/serverManager';
import { Logger } from './utils/logger';
import { DiagnosticsManager } from './features/diagnostics';
import { registerBuildCommands } from './commands/buildCommands';
import { registerProjectCommands } from './commands/projectCommands';
import { registerDebugger } from './debugger/configProvider';
import { registerReferenceFeatures } from './features/references';
import { registerTestingFeatures } from './features/testing';
import { ProjectContext } from './status/projectContext';

let serverManager: ServerManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const logger = new Logger();
  context.subscriptions.push(logger);

  logger.info('GSharp extension activating...');

  // Diagnostics manager for build output
  const diagnosticsManager = new DiagnosticsManager();
  context.subscriptions.push(diagnosticsManager);

  // Start the language server
  serverManager = new ServerManager(context, logger);
  await serverManager.start();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.restartServer', async () => {
      if (serverManager) {
        logger.info('Restarting language server...');
        await serverManager.restart();
      }
    }),
    vscode.commands.registerCommand('gsharp.openOutput', () => {
      logger.show();
    }),
  );

  registerBuildCommands(context, diagnosticsManager, logger);
  registerProjectCommands(context);
  registerReferenceFeatures(context);
  registerTestingFeatures(context, () => serverManager?.getClient(), logger);

  // Register debugger
  registerDebugger(context);

  // Project context status bar
  const projectContext = new ProjectContext();
  context.subscriptions.push(projectContext);
  await projectContext.update();

  logger.info('GSharp extension activated.');
}

export function deactivate(): Thenable<void> | undefined {
  if (serverManager) {
    return serverManager.stop();
  }
  return undefined;
}

