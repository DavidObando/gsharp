import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

/**
 * Manages inlay hints settings and refresh triggers.
 * The actual inlay hints are provided by the language server via LSP.
 */
export function registerInlayHintsFeatures(
  context: vscode.ExtensionContext,
  _client: LanguageClient,
) {
  // Listen for configuration changes to refresh inlay hints
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('gsharp.inlayHints.enableParameterNames') ||
        e.affectsConfiguration('gsharp.inlayHints.enableTypeHints')
      ) {
        // Trigger inlay hints refresh for all visible editors
        vscode.commands.executeCommand('editor.action.inlayHints.toggle');
        vscode.commands.executeCommand('editor.action.inlayHints.toggle');
      }
    }),
  );
}
