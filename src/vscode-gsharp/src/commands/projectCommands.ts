import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  computeLaunchPaths,
  computeWorkspaceTaskPath,
  findRunnableProjects,
  type ProjectMetadata,
} from '../utils/projectLayout';

/**
 * Selects the runnable `.gsproj` to launch from a list of workspace project paths:
 * excludes non-runnable projects (`OutputType` is not `Exe`/`WinExe`), selects
 * the sole runnable project automatically, or prompts the user when multiple exist.
 */
export async function selectRunnableProject(
  workspaceFolderPath: string,
  projectPaths: readonly string[],
): Promise<ProjectMetadata | undefined> {
  const runnable = findRunnableProjects(projectPaths, workspaceFolderPath);
  if (runnable.length === 0) {
    return undefined;
  }
  if (runnable.length === 1) {
    return runnable[0];
  }
  if (typeof vscode.window.showQuickPick !== 'function') {
    return runnable[0];
  }
  const items = runnable.map((project) => ({
    label: project.projectName,
    description: computeWorkspaceTaskPath(workspaceFolderPath, project.projectPath),
    project,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the runnable G# project to launch',
  });
  return picked?.project;
}

export function registerProjectCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.generateAssets', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }

      const projectFiles = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**');
      if (projectFiles.length === 0) {
        vscode.window.showWarningMessage('No .gsproj file found in the workspace.');
        return;
      }

      const projectPaths = projectFiles.map((file) => file.fsPath);
      if (findRunnableProjects(projectPaths, workspaceFolder.uri.fsPath).length === 0) {
        vscode.window.showWarningMessage(
          'No runnable .gsproj file (OutputType Exe or WinExe) found in the workspace.',
        );
        return;
      }

      const targetProject = await selectRunnableProject(
        workspaceFolder.uri.fsPath,
        projectPaths,
      );
      if (!targetProject) {
        return;
      }

      const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');

      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }

      // Generate tasks.json
      const tasksPath = path.join(vscodeDir, 'tasks.json');
      if (!fs.existsSync(tasksPath)) {
        const taskProjectPath = computeWorkspaceTaskPath(
          workspaceFolder.uri.fsPath,
          targetProject.projectPath,
        );
        const tasks = {
          version: '2.0.0',
          tasks: [
            {
              label: 'dotnet: build',
              command: 'dotnet',
              type: 'process',
              args: ['build', taskProjectPath],
              problemMatcher: '$msCompile',
              group: {
                kind: 'build',
                isDefault: true,
              },
            },
          ],
        };
        fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
      }

      // Generate launch.json
      const launchPath = path.join(vscodeDir, 'launch.json');
      if (!fs.existsSync(launchPath)) {
        const { program, cwd } = computeLaunchPaths(
          workspaceFolder.uri.fsPath,
          targetProject.projectPath,
          targetProject.targetFramework,
          targetProject.assemblyName,
        );
        const launch = {
          version: '0.2.0',
          configurations: [
            {
              name: `Launch ${targetProject.projectName}`,
              type: 'coreclr',
              request: 'launch',
              preLaunchTask: 'dotnet: build',
              program,
              args: [],
              cwd,
              console: 'integratedTerminal',
              stopAtEntry: false,
            },
          ],
        };
        fs.writeFileSync(launchPath, JSON.stringify(launch, null, 2));
      }

      vscode.window.showInformationMessage('GSharp: Build and debug assets generated.');
    }),

    vscode.commands.registerCommand('gsharp.reportIssue', () => {
      vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/DavidObando/gsharp/issues/new'),
      );
    }),
  );
}
