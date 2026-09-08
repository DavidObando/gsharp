const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description, action, predicate, timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let last;
  while (Date.now() < deadline) {
    last = await action();
    if (predicate(last)) {
      return last;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${String(last)}`);
}

function positionOf(document, text, occurrence = 0) {
  const source = document.getText();
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) {
    offset = source.indexOf(text, offset + 1);
  }
  assert.notStrictEqual(offset, -1, `Could not find '${text}' occurrence ${occurrence}.`);
  return document.positionAt(offset);
}

async function executeProvider(command, uri, position) {
  return waitFor(
    command,
    () => vscode.commands.executeCommand(command, uri, position),
    (value) => (Array.isArray(value) ? value.length > 0 : value != null),
  );
}

async function executeTaskCommand(command, taskName) {
  const ended = new Promise((resolve) => {
    const subscription = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.source === 'gsharp' && event.execution.task.name === taskName) {
        subscription.dispose();
        resolve(event.exitCode);
      }
    });
  });
  await vscode.commands.executeCommand(command);
  const exitCode = await Promise.race([
    ended,
    delay(120000).then(() => {
      throw new Error(`${taskName} task did not finish.`);
    }),
  ]);
  assert.strictEqual(exitCode, 0, `${taskName} task failed with exit code ${exitCode}.`);
}

async function debugProgram(folder, document) {
  const marker = 'Console.WriteLine(JsonConvert.SerializeObject(result))';
  const breakpointLine = positionOf(document, marker).line;
  const breakpoint = new vscode.SourceBreakpoint(
    new vscode.Location(document.uri, new vscode.Position(breakpointLine, 0)),
  );
  vscode.debug.addBreakpoints([breakpoint]);

  let stoppedResolve;
  let stoppedReject;
  const stopped = new Promise((resolve, reject) => {
    stoppedResolve = resolve;
    stoppedReject = reject;
  });

  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session) {
      return {
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') {
            Promise.resolve()
              .then(async () => {
                assert.strictEqual(message.body.reason, 'breakpoint');
                const stack = await session.customRequest('stackTrace', {
                  threadId: message.body.threadId,
                });
                assert.ok(stack.stackFrames.length > 0, 'Debugger returned no stack frames.');
                const frame = stack.stackFrames[0];
                assert.strictEqual(
                  frame.line,
                  breakpointLine + 1,
                  `Debugger stopped at ${frame.source?.path}:${frame.line}.`,
                );
                const input = await session.customRequest('evaluate', {
                  expression: 'input',
                  frameId: frame.id,
                  context: 'watch',
                });
                const result = await session.customRequest('evaluate', {
                  expression: 'result',
                  frameId: stack.stackFrames[0].id,
                  context: 'watch',
                });
                assert.strictEqual(input.result, '20');
                assert.strictEqual(result.result, '42');
                stoppedResolve();
                await session.customRequest('continue', { threadId: message.body.threadId });
              })
              .catch(stoppedReject);
          }
        },
      };
    },
  });

  const terminated = new Promise((resolve) => {
    const subscription = vscode.debug.onDidTerminateDebugSession(() => {
      subscription.dispose();
      resolve();
    });
  });

  try {
    const started = await vscode.debug.startDebugging(folder, {
      name: 'GSharp live acceptance',
      type: 'gsharp',
      request: 'launch',
      program: path.join(folder.uri.fsPath, 'bin', 'Debug', 'net10.0', 'Console.dll'),
      cwd: folder.uri.fsPath,
      console: 'internalConsole',
    });
    assert.strictEqual(started, true, 'VS Code did not start the GSharp debug session.');
    await Promise.race([
      stopped,
      delay(60000).then(() => {
        throw new Error('Debugger did not stop at the GSharp breakpoint.');
      }),
    ]);
    await Promise.race([
      terminated,
      delay(30000).then(() => {
        throw new Error('Debug session did not terminate.');
      }),
    ]);
  } finally {
    tracker.dispose();
    vscode.debug.removeBreakpoints([breakpoint]);
  }
}

async function runTestExplorer(folder) {
  const testDirectory = vscode.Uri.joinPath(folder.uri, 'Live.Tests');
  const projectUri = vscode.Uri.joinPath(testDirectory, 'Live.Tests.gsproj');
  const sourceUri = vscode.Uri.joinPath(testDirectory, 'LiveTests.gs');
  const markerUri = vscode.Uri.joinPath(testDirectory, 'test-explorer.passed');
  const markerPath = markerUri.fsPath.replace(/\\/g, '/');

  await vscode.workspace.fs.createDirectory(testDirectory);
  await vscode.workspace.fs.writeFile(
    projectUri,
    Buffer.from(
      '<Project Sdk="Gsharp.NET.Sdk/0.3.159">\n' +
        '  <PropertyGroup>\n' +
        '    <TargetFramework>net10.0</TargetFramework>\n' +
        '    <IsPackable>false</IsPackable>\n' +
        '    <IsTestProject>true</IsTestProject>\n' +
        '  </PropertyGroup>\n' +
        '  <ItemGroup>\n' +
        '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n' +
        '    <PackageReference Include="xunit" Version="2.9.2" />\n' +
        '    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />\n' +
        '  </ItemGroup>\n' +
        '</Project>\n',
    ),
  );
  const source =
    'package Live.Tests\n\n' +
    'import System.IO\n' +
    'import Xunit\n\n' +
    'class LiveTests {\n' +
    '    @Fact\n' +
    '    func RunsInVsCode() {\n' +
    `        File.WriteAllText("${markerPath}", "passed")\n` +
    '    }\n' +
    '}\n';
  await vscode.workspace.fs.writeFile(sourceUri, Buffer.from(source));

  const document = await vscode.workspace.openTextDocument(sourceUri);
  const editor = await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('gsharp.restartServer');
  await waitFor(
    'new test project discovery',
    () => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', sourceUri),
    (value) => Array.isArray(value) && value.some((symbol) => symbol.name === 'LiveTests'),
    60000,
  );
  editor.selection = new vscode.Selection(
    positionOf(document, 'RunsInVsCode'),
    positionOf(document, 'RunsInVsCode'),
  );
  await vscode.commands.executeCommand('gsharp.test.runInContext');
  let marker;
  try {
    marker = await vscode.workspace.fs.readFile(markerUri);
  } catch {
    assert.fail('Test Explorer run did not execute the selected G# test.');
  }
  assert.strictEqual(Buffer.from(marker).toString(), 'passed');
}

async function verifyFormatting(document) {
  const original = document.getText();
  const malformed = original.replace('var input = 20', 'var input=20');
  assert.notStrictEqual(malformed, original, 'Could not create malformed formatting input.');

  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(original.length));
  const makeMalformed = new vscode.WorkspaceEdit();
  makeMalformed.replace(document.uri, fullRange, malformed);
  assert.strictEqual(await vscode.workspace.applyEdit(makeMalformed), true);

  const edits = await vscode.commands.executeCommand(
    'vscode.executeFormatDocumentProvider',
    document.uri,
  );
  assert.ok(Array.isArray(edits) && edits.length > 0, 'Formatter returned no edits.');

  const applyFormatting = new vscode.WorkspaceEdit();
  applyFormatting.set(document.uri, edits);
  assert.strictEqual(await vscode.workspace.applyEdit(applyFormatting), true);
  assert.ok(document.getText().includes('var input = 20'));
  assert.ok(!document.getText().includes('var input=20'));
}

async function run() {
  const extension = vscode.extensions.getExtension('gsharplang.vscode-gsharp');
  assert.ok(extension, 'GSharp extension was not loaded.');
  await extension.activate();
  assert.strictEqual(extension.isActive, true);

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'The live fixture workspace was not opened.');
  const uri = vscode.Uri.joinPath(folder.uri, 'Program.gs');
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.strictEqual(document.languageId, 'gsharp');

  const symbols = await waitFor(
    'language server startup',
    () => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri),
    (value) => Array.isArray(value) && value.length > 0,
    60000,
  );
  assert.ok(symbols.length > 0);

  await vscode.commands.executeCommand('gsharp.generateAssets');
  const tasks = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
  const launch = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
  assert.ok((await vscode.workspace.fs.stat(tasks)).type & vscode.FileType.File);
  assert.ok((await vscode.workspace.fs.stat(launch)).type & vscode.FileType.File);

  await executeTaskCommand('gsharp.buildProject', 'build');

  const greeterPosition = positionOf(document, 'Greeter("debugger")');
  const definitions = await executeProvider(
    'vscode.executeDefinitionProvider',
    uri,
    greeterPosition,
  );
  const definitionUri = definitions[0].targetUri || definitions[0].uri;
  assert.ok(definitionUri.fsPath.endsWith(path.join('Library', 'Greeter.gs')));

  const hover = await executeProvider('vscode.executeHoverProvider', uri, greeterPosition);
  assert.ok(hover.length > 0);

  const completionPosition = positionOf(document, 'Console.WriteLine').translate(
    0,
    'Console.'.length,
  );
  const completions = await executeProvider(
    'vscode.executeCompletionItemProvider',
    uri,
    completionPosition,
  );
  assert.ok(completions.items.some((item) => String(item.label) === 'WriteLine'));

  await verifyFormatting(document);

  const semanticTokens = await waitFor(
    'semantic tokens',
    () => vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri),
    (value) => value && value.data && value.data.length > 0,
  );
  assert.ok(semanticTokens.data.length > 0);

  await executeTaskCommand('gsharp.runProject', 'run');
  await debugProgram(folder, document);
  await runTestExplorer(folder);

  const errors = vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
  assert.deepStrictEqual(errors, []);
}

module.exports = { run };
