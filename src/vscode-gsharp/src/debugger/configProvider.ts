import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolves 'gsharp' debug configurations to 'coreclr'.
 * Since GSharp compiles to standard .NET assemblies, we use the CoreCLR debugger (vsdbg).
 */
export class GSharpDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // If the user explicitly chose 'gsharp' type, convert to 'coreclr'
    if (config.type === 'gsharp') {
      config.type = 'coreclr';
    }

    // If no program is specified, try to auto-detect
    if (!config.program && folder) {
      config.program = '${workspaceFolder}/bin/Debug/net10.0/${workspaceFolderBasename}.dll';
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
  provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    const projectName = folder
      ? path.basename(folder.uri.fsPath)
      : 'GSharpApp';

    return [
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
