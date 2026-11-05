import * as vscode from 'vscode';
import * as path from 'path';
import { selectRunnableProject } from '../commands/projectCommands';
import { computeLaunchPaths, type ProjectMetadata } from '../utils/projectLayout';

/**
 * Finds the runnable `.gsproj` within a workspace folder, if any.
 */
async function findPrimaryProject(
  folder: vscode.WorkspaceFolder,
): Promise<ProjectMetadata | undefined> {
  const pattern = new vscode.RelativePattern(folder, '**/*.gsproj');
  const matches = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
  if (matches.length === 0) {
    return undefined;
  }
  return selectRunnableProject(
    folder.uri.fsPath,
    matches.map((m) => m.fsPath),
  );
}

/**
 * Resolves 'gsharp' debug configurations to 'coreclr'.
 * Since GSharp compiles to standard .NET assemblies, we use the CoreCLR debugger (vsdbg).
 */
export class GSharpDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration> {
    // If the user explicitly chose 'gsharp' type, convert to 'coreclr'
    if (config.type === 'gsharp') {
      config.type = 'coreclr';
    }

    // If no program is specified, try to auto-detect from the project layout.
    if (!config.program && folder) {
      const targetProject = await findPrimaryProject(folder);
      if (targetProject) {
        const { program, cwd } = computeLaunchPaths(
          folder.uri.fsPath,
          targetProject.projectPath,
          targetProject.targetFramework,
          targetProject.assemblyName,
        );
        config.program = program;
        if (!config.cwd) {
          config.cwd = cwd;
        }
      } else {
        config.program = '${workspaceFolder}/bin/Debug/net10.0/${workspaceFolderBasename}.dll';
      }
    }

    if (!config.cwd && folder) {
      config.cwd = '${workspaceFolder}';
    }

    if (!config.console) {
      config.console = 'integratedTerminal';
    }

    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // After variable substitution, verify the program path exists or warn
    if (config.program) {
      const fs = await import('fs');
      if (!fs.existsSync(config.program)) {
        const choice = await vscode.window.showWarningMessage(
          `Debug target not found: ${config.program}. Build the project first?`,
          'Build & Launch',
          'Cancel',
        );
        if (choice === 'Build & Launch') {
          await vscode.commands.executeCommand('gsharp.buildProject');
          // Return config to proceed with debugging after build
          return config;
        }
        return undefined;
      }
    }
    return config;
  }
}

/**
 * Provides initial debug configurations when no launch.json exists.
 */
export class GSharpDebugConfigurationInitialProvider
  implements vscode.DebugConfigurationProvider
{
  async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    _token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration[]> {
    const targetProject = folder ? await findPrimaryProject(folder) : undefined;
    const projectName = targetProject
      ? targetProject.projectName
      : folder
        ? path.basename(folder.uri.fsPath)
        : 'GSharpApp';
    const { program, cwd } =
      folder && targetProject
        ? computeLaunchPaths(
            folder.uri.fsPath,
            targetProject.projectPath,
            targetProject.targetFramework,
            targetProject.assemblyName,
          )
        : {
            program: `\${workspaceFolder}/bin/Debug/net10.0/${projectName}.dll`,
            cwd: '${workspaceFolder}',
          };

    return [
      {
        name: `Launch ${projectName}`,
        type: 'coreclr',
        request: 'launch',
        preLaunchTask: 'dotnet: build',
        program,
        args: [],
        cwd,
        console: 'integratedTerminal',
        stopAtEntry: false,
      },
    ];
  }
}

export function registerDebugger(context: vscode.ExtensionContext) {
  const configProvider = new GSharpDebugConfigurationProvider();
  const initialProvider = new GSharpDebugConfigurationInitialProvider();

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('gsharp', configProvider),
    vscode.debug.registerDebugConfigurationProvider('gsharp', initialProvider, vscode.DebugConfigurationProviderTriggerKind.Initial),
  );
}
