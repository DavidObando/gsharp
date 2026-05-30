import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function registerProjectCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.generateAssets', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }

      const projectFiles = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**', 1);
      if (projectFiles.length === 0) {
        vscode.window.showWarningMessage('No .gsproj file found in the workspace.');
        return;
      }

      const projectPath = projectFiles[0].fsPath;
      const projectName = path.basename(projectPath, '.gsproj');
      const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');

      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }

      // Generate tasks.json
      const tasksPath = path.join(vscodeDir, 'tasks.json');
      if (!fs.existsSync(tasksPath)) {
        const tasks = {
          version: '2.0.0',
          tasks: [
            {
              label: 'dotnet: build',
              command: 'dotnet',
              type: 'process',
              args: ['build', projectPath],
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
        const launch = {
          version: '0.2.0',
          configurations: [
            {
              name: `Launch ${projectName}`,
              type: 'coreclr',
              request: 'launch',
              preLaunchTask: 'dotnet: build',
              program: `\${workspaceFolder}/bin/Debug/net10.0/${projectName}.dll`,
              args: [],
              cwd: '${workspaceFolder}',
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
