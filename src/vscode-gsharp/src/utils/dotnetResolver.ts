import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';

export async function resolveDotnetRuntime(
  _context: vscode.ExtensionContext,
): Promise<string> {
  // Check if dotnet is available on PATH first
  try {
    execSync('dotnet --version', { stdio: 'pipe' });
    return 'dotnet';
  } catch {
    // dotnet not on PATH, try the .NET Install Tool extension
  }

  const dotnetExtension = vscode.extensions.getExtension('ms-dotnettools.vscode-dotnet-runtime');
  if (dotnetExtension) {
    if (!dotnetExtension.isActive) {
      await dotnetExtension.activate();
    }
    try {
      const result = await vscode.commands.executeCommand<{ dotnetPath: string }>(
        'dotnet.findPath',
        { requestingExtensionId: 'gsharp.vscode-gsharp' },
      );
      if (result?.dotnetPath) {
        return result.dotnetPath;
      }
    } catch {
      // Fall through
    }
  }

  // Last resort — hope it's on PATH
  return 'dotnet';
}

export function getServerPath(context: vscode.ExtensionContext): string {
  const config = vscode.workspace.getConfiguration('gsharp');
  const configuredPath = config.get<string>('server.path', '');
  if (configuredPath) {
    return configuredPath;
  }

  // Use bundled server
  return path.join(context.extensionPath, '.server', 'GSharp.LanguageServer.dll');
}
