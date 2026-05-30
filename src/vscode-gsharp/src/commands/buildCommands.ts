import * as vscode from 'vscode';
import { DiagnosticsManager } from '../features/diagnostics';
import { Logger } from '../utils/logger';

export function registerBuildCommands(
  context: vscode.ExtensionContext,
  diagnosticsManager: DiagnosticsManager,
  logger: Logger,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.buildProject', async () => {
      const projectFile = await findProjectFile();
      if (!projectFile) {
        vscode.window.showWarningMessage('No .gsproj file found in the workspace.');
        return;
      }

      logger.info(`Building project: ${projectFile}`);
      diagnosticsManager.clearBuildDiagnostics();

      const task = new vscode.Task(
        { type: 'gsharp', task: 'build', project: projectFile },
        vscode.TaskScope.Workspace,
        'build',
        'gsharp',
        new vscode.ShellExecution('dotnet', ['build', projectFile]),
        '$msCompile',
      );

      const execution = await vscode.tasks.executeTask(task);
      context.subscriptions.push(
        vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution === execution) {
            if (e.exitCode === 0) {
              logger.info('Build succeeded.');
              vscode.window.showInformationMessage('GSharp: Build succeeded.');
            } else {
              logger.error('Build failed.');
              vscode.window.showErrorMessage('GSharp: Build failed. Check the Problems panel.');
            }
          }
        }),
      );
    }),

    vscode.commands.registerCommand('gsharp.runProject', async () => {
      const projectFile = await findProjectFile();
      if (!projectFile) {
        vscode.window.showWarningMessage('No .gsproj file found in the workspace.');
        return;
      }

      logger.info(`Running project: ${projectFile}`);

      const task = new vscode.Task(
        { type: 'gsharp', task: 'run', project: projectFile },
        vscode.TaskScope.Workspace,
        'run',
        'gsharp',
        new vscode.ShellExecution('dotnet', ['run', '--project', projectFile]),
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always };
      await vscode.tasks.executeTask(task);
    }),
  );
}

async function findProjectFile(): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**', 1);
  if (files.length > 0) {
    return files[0].fsPath;
  }
  return undefined;
}
