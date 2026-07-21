import * as vscode from 'vscode';

export interface GSharpInitializationOptions {
  formattingIndentSize: number;
  formattingUseTabs: boolean;
  diagnosticsOnType: boolean;
  completionTriggerOnDot: boolean;
  referenceCodeLens: boolean;
  parameterNameInlayHints: boolean;
  typeInlayHints: boolean;
  coldStartCache: boolean;
}

export function getServerOptions() {
  const config = vscode.workspace.getConfiguration('gsharp');
  const initializationOptions: GSharpInitializationOptions = {
    formattingIndentSize: Math.max(1, config.get<number>('formatting.indentSize', 4)),
    formattingUseTabs: config.get<boolean>('formatting.useTabs', false),
    diagnosticsOnType: config.get<boolean>('diagnostics.enableOnType', true),
    completionTriggerOnDot: config.get<boolean>('completion.triggerOnDot', true),
    referenceCodeLens: config.get<boolean>('codeLens.enableReferences', true),
    parameterNameInlayHints: config.get<boolean>('inlayHints.enableParameterNames', true),
    typeInlayHints: config.get<boolean>('inlayHints.enableTypeHints', true),
    coldStartCache: isColdStartCacheEnabled(config),
  };

  return {
    path: config.get<string>('server.path', ''),
    waitForDebugger: config.get<boolean>('server.waitForDebugger', false),
    log: config.get<boolean>('server.log', false),
    logPath: config.get<string>('server.logPath', ''),
    initializationOptions,
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
