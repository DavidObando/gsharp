import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/**
 * Manages CodeLens settings.
 * The actual CodeLens items are provided by the language server via LSP.
 */
export function registerCodeLensFeatures(
  context: vscode.ExtensionContext,
  _client: LanguageClient,
) {
  // Listen for configuration changes to refresh code lenses
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gsharp.codeLens.enableReferences')) {
        // Trigger a CodeLens refresh
        vscode.commands.executeCommand('codelens.refresh');
      }
    }),
  );
}
