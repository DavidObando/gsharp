// Minimal stub of the VS Code API so unit tests can import modules that reference
// `vscode` without running inside the extension host. Extend as tests require.
module.exports = {
  extensions: {
    getExtension: () => undefined,
  },
  commands: {
    executeCommand: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
    }),
  },
  window: {
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
  env: {
    openExternal: async () => true,
  },
  Uri: {
    parse: (value) => ({
      scheme: value.slice(0, value.indexOf(':')),
      toString: (skipEncoding) => (skipEncoding ? decodeURIComponent(value) : value),
    }),
  },
  Range: class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
};
