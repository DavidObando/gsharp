// Minimal stub of the VS Code API so unit tests can import modules that reference
// `vscode` without running inside the extension host. Extend as tests require.
class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

exports.extensions = {
  getExtension: () => undefined,
};
exports.commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose: () => {} }),
};
exports.workspace = {
  workspaceFolders: undefined,
  findFiles: async () => [],
  getConfiguration: () => ({
    get: (_key, fallback) => fallback,
  }),
};
exports.window = {
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showQuickPick: async (items) => (Array.isArray(items) ? items[0] : undefined),
  createOutputChannel: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    show: () => {},
    dispose: () => {},
  }),
};
exports.RelativePattern = RelativePattern;
exports.env = {
  openExternal: async () => true,
};
exports.Uri = {
  parse: (value) => ({
    scheme: value.slice(0, value.indexOf(':')),
    toString: (skipEncoding) => (skipEncoding ? decodeURIComponent(value) : value),
  }),
};
exports.Range = Range;
