const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite');
  const repoRoot = path.resolve(extensionDevelopmentPath, '../..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsharp-vscode-live-'));
  const sourceRoot = path.join(repoRoot, 'src', 'vs-gsharp', 'test', 'ProjectDebugFixtures');

  fs.cpSync(path.join(sourceRoot, 'Console'), path.join(fixtureRoot, 'Console'), {
    recursive: true,
    filter: (source) => !/[\\/](?:bin|obj|\.vscode)(?:[\\/]|$)/i.test(source),
  });
  fs.cpSync(path.join(sourceRoot, 'Library'), path.join(fixtureRoot, 'Library'), {
    recursive: true,
    filter: (source) => !/[\\/](?:bin|obj|\.vscode)(?:[\\/]|$)/i.test(source),
  });

  const executable =
    process.env.VSCODE_EXECUTABLE_PATH ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
      : undefined);
  if (!executable) {
    throw new Error(
      'Set VSCODE_EXECUTABLE_PATH to the installed VS Code executable on this platform.',
    );
  }
  if (!fs.existsSync(executable)) {
    throw new Error(`Installed VS Code executable was not found: ${executable}`);
  }

  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        path.join(fixtureRoot, 'Console'),
        `--extensions-dir=${path.join(os.homedir(), '.vscode', 'extensions')}`,
        `--user-data-dir=${path.join(fixtureRoot, 'user-data')}`,
      ],
      extensionTestsEnv: {
        GSHARP_VSCODE_FIXTURE_ROOT: fixtureRoot,
      },
    });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
