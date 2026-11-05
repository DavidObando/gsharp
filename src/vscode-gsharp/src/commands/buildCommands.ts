import * as vscode from 'vscode';
import { DiagnosticsManager } from '../features/diagnostics';
import { Logger } from '../utils/logger';
import { selectRunnableProject } from './projectCommands';

export function registerBuildCommands(
  context: vscode.ExtensionContext,
  diagnosticsManager: DiagnosticsManager,
  logger: Logger,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.buildProject', async () => {
      const projectFile = await findProjectFile(false);
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
      const projectFile = await findProjectFile(true);
      if (!projectFile) {
        vscode.window.showWarningMessage(
          'No runnable .gsproj file (OutputType Exe or WinExe) found in the workspace.',
        );
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

async function findProjectFile(requireRunnable: boolean): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**');
  if (files.length === 0) {
    return undefined;
  }
  const workspaceFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const runnable = await selectRunnableProject(
    workspaceFolderPath,
    files.map((f) => f.fsPath),
  );
  if (runnable) {
    return runnable.projectPath;
  }
  return requireRunnable ? undefined : files[0].fsPath;
}
