import * as vscode from 'vscode';

export function getServerOptions() {
  const config = vscode.workspace.getConfiguration('gsharp');
  return {
    path: config.get<string>('server.path', ''),
    startTimeout: config.get<number>('server.startTimeout', 30000),
    waitForDebugger: config.get<boolean>('server.waitForDebugger', false),
    log: config.get<boolean>('server.log', false),
    logPath: config.get<string>('server.logPath', ''),
    trace: config.get<string>('trace.server', 'off'),
    coldStartCacheEnabled: isColdStartCacheEnabled(config),
  };
}

/**
 * Resolves whether the cold-start cache (ADR-0107) should be enabled.
 *
 * The G#-owned `gsharp.coldStartCache.enable` setting is authoritative when the
 * user has set it. When it is left unset, we honor the C# Dev Kit setting
 * `dotnet.projectsystem.enableLanguageServiceCache` as a fallback if present —
 * so users who already manage a single cache toggle for their .NET tooling get
 * consistent behavior — defaulting to enabled otherwise.
 *
 * We deliberately only *read* the `dotnet.projectsystem.*` key (owned by the C#
 * Dev Kit extension); we never contribute it.
 */
function isColdStartCacheEnabled(config: vscode.WorkspaceConfiguration): boolean {
  const inspected = config.inspect<boolean>('coldStartCache.enable');
  const explicit =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue;
  if (explicit !== undefined) {
    return explicit;
  }

  const csharp = vscode.workspace
    .getConfiguration('dotnet.projectsystem')
    .get<boolean>('enableLanguageServiceCache');
  return csharp ?? true;
}
