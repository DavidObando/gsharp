import * as vscode from 'vscode';

interface LspPosition {
  line: number;
  character: number;
}

/**
 * Registers the `gsharp.showReferences` command emitted by the language server's
 * reference CodeLenses. The CodeLens command carries the document URI and the
 * symbol position; this handler resolves the references via the reference
 * provider and opens VS Code's built-in references peek view.
 */
export function registerReferenceFeatures(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'gsharp.showReferences',
      async (uri?: string | vscode.Uri, position?: LspPosition | vscode.Position) => {
        if (!uri || !position) {
          return;
        }

        const targetUri = uri instanceof vscode.Uri ? uri : vscode.Uri.parse(uri);
        const targetPosition =
          position instanceof vscode.Position
            ? position
            : new vscode.Position(position.line, position.character);

        const locations =
          (await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            targetUri,
            targetPosition,
          )) ?? [];

        await vscode.commands.executeCommand(
          'editor.action.showReferences',
          targetUri,
          targetPosition,
          locations,
        );
      },
    ),
  );
}
