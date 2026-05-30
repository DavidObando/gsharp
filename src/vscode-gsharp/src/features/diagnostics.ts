import * as vscode from 'vscode';

export class DiagnosticsManager {
  private readonly buildDiagnostics: vscode.DiagnosticCollection;

  constructor() {
    this.buildDiagnostics = vscode.languages.createDiagnosticCollection('gsharp-build');
  }

  /**
   * Parse MSBuild-format diagnostic output lines and push to the build diagnostics collection.
   * Format: file(line,col): error/warning CODE: message
   */
  parseBuildOutput(output: string) {
    const diagnosticMap = new Map<string, vscode.Diagnostic[]>();
    const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(\w+):\s+(.+)$/gm;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const [, filePath, lineStr, colStr, severity, code, message] = match;
      const line = parseInt(lineStr, 10) - 1;
      const col = parseInt(colStr, 10) - 1;

      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(line, col, line, col),
        message,
        severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.code = code;
      diagnostic.source = 'gsharp-build';

      const existing = diagnosticMap.get(filePath) || [];
      existing.push(diagnostic);
      diagnosticMap.set(filePath, existing);
    }

    this.buildDiagnostics.clear();
    for (const [filePath, diagnostics] of diagnosticMap) {
      this.buildDiagnostics.set(vscode.Uri.file(filePath), diagnostics);
    }
  }

  clearBuildDiagnostics() {
    this.buildDiagnostics.clear();
  }

  dispose() {
    this.buildDiagnostics.dispose();
  }
}
