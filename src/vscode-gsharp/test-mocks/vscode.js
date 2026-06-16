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
    parse: (value) => ({ toString: () => value }),
  },
};
