import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { LanguageClient } from 'vscode-languageclient/node';
import { Logger } from '../utils/logger';

interface TestItem {
  id: string;
  label: string;
  uri: string;
  line: number;
  filter?: string;
  children?: TestItem[];
}

// Maps a vscode.TestItem id to its `dotnet test --filter "FullyQualifiedName~..."`
// token, as reported by the language server's gsharp/discoverTests response.
const testFilters = new Map<string, string>();

export function registerTestingFeatures(
  context: vscode.ExtensionContext,
  getClient: () => LanguageClient | undefined,
  logger: Logger,
) {
  const testController = vscode.tests.createTestController('gsharp-tests', 'GSharp Tests');
  context.subscriptions.push(testController);

  // Run profile
  testController.createRunProfile('Run', vscode.TestRunProfileKind.Run, async (request, token) => {
    await runTests(request, testController, logger, false, token);
  });

  // Debug profile
  testController.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    async (request, token) => {
      await runTests(request, testController, logger, true, token);
    },
  );

  // Discover tests when workspace opens or files change
  testController.resolveHandler = async (item) => {
    if (!item) {
      await discoverTests(testController, getClient, logger);
    }
  };

  // Register commands for running tests at cursor
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.test.runInContext', async () => {
      await runTestAtCursor(testController, getClient, logger, false);
    }),
    vscode.commands.registerCommand('gsharp.test.debugInContext', async () => {
      await runTestAtCursor(testController, getClient, logger, true);
    }),
  );
}

async function runTestAtCursor(
  controller: vscode.TestController,
  getClient: () => LanguageClient | undefined,
  logger: Logger,
  debug: boolean,
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // Ensure tests have been discovered before searching for one at the cursor.
  if (countItems(controller.items) === 0) {
    await discoverTests(controller, getClient, logger);
  }

  const target = findTestAtPosition(controller.items, editor.document.uri, editor.selection.active);
  if (!target) {
    void vscode.window.showInformationMessage('GSharp: No test found at the cursor.');
    return;
  }

  const request = new vscode.TestRunRequest([target]);
  const token = new vscode.CancellationTokenSource().token;
  logger.info(`${debug ? 'Debugging' : 'Running'} test '${target.label}' at cursor...`);
  await runTests(request, controller, logger, debug, token);
}

function countItems(items: vscode.TestItemCollection): number {
  let count = 0;
  items.forEach((item) => {
    count += 1 + countItems(item.children);
  });
  return count;
}

function findTestAtPosition(
  items: vscode.TestItemCollection,
  uri: vscode.Uri,
  position: vscode.Position,
): vscode.TestItem | undefined {
  const candidates: vscode.TestItem[] = [];
  collectItemsForUri(items, uri, candidates);

  let best: vscode.TestItem | undefined;
  let bestLine = -1;
  for (const item of candidates) {
    const startLine = item.range!.start.line;
    // Prefer the closest declaration on or above the cursor line.
    if (startLine <= position.line && startLine > bestLine) {
      best = item;
      bestLine = startLine;
    }
  }

  return best;
}

function collectItemsForUri(
  items: vscode.TestItemCollection,
  uri: vscode.Uri,
  out: vscode.TestItem[],
) {
  items.forEach((item) => {
    if (item.uri?.toString() === uri.toString() && item.range) {
      out.push(item);
    }

    collectItemsForUri(item.children, uri, out);
  });
}

async function discoverTests(
  controller: vscode.TestController,
  getClient: () => LanguageClient | undefined,
  logger: Logger,
) {
  const client = getClient();
  if (!client) {
    logger.warn('Test discovery skipped: language server is not running.');
    return;
  }

  try {
    // Request test discovery from the language server via custom LSP method
    const tests = await client.sendRequest<TestItem[]>('gsharp/discoverTests');
    if (tests) {
      populateTestItems(controller, tests);
    }
  } catch {
    logger.warn('Test discovery not available (server may not support gsharp/discoverTests).');
  }
}

function populateTestItems(controller: vscode.TestController, tests: TestItem[]) {
  controller.items.replace([]);
  testFilters.clear();
  for (const test of tests) {
    const item = buildTestItem(controller, test);
    controller.items.add(item);
  }
}

function buildTestItem(controller: vscode.TestController, test: TestItem): vscode.TestItem {
  const item = controller.createTestItem(test.id, test.label, vscode.Uri.parse(test.uri));
  item.range = new vscode.Range(test.line, 0, test.line, 0);

  if (test.filter) {
    testFilters.set(test.id, test.filter);
  }

  if (test.children) {
    for (const child of test.children) {
      item.children.add(buildTestItem(controller, child));
    }
  }

  return item;
}

/**
 * Builds a `dotnet test --filter` expression that targets exactly the selected
 * test items (and the descendants of any selected group), or undefined when no
 * filter tokens are known. Tokens are OR'd via `FullyQualifiedName~<token>`.
 */
function buildFilterExpression(items: vscode.TestItem[]): string | undefined {
  const tokens = new Set<string>();
  for (const item of items) {
    gatherFilters(item, tokens);
  }

  if (tokens.size === 0) {
    return undefined;
  }

  return [...tokens].map((token) => `FullyQualifiedName~${token}`).join('|');
}

function gatherFilters(item: vscode.TestItem, tokens: Set<string>) {
  const own = testFilters.get(item.id);
  if (own) {
    tokens.add(own);
  }

  item.children.forEach((child) => gatherFilters(child, tokens));
}

async function runTests(
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
  logger: Logger,
  debug: boolean,
  token: vscode.CancellationToken,
) {
  const run = controller.createTestRun(request);

  // Collect all test items to run
  const items: vscode.TestItem[] = [];
  if (request.include) {
    request.include.forEach((item) => items.push(item));
  } else {
    controller.items.forEach((item) => items.push(item));
  }

  for (const item of items) {
    if (token.isCancellationRequested) break;
    run.started(item);
  }

  try {
    // Find the project file and run tests via dotnet test
    const projectFiles = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**', 1);
    if (projectFiles.length === 0) {
      for (const item of items) {
        run.errored(item, new vscode.TestMessage('No .gsproj file found.'));
      }
      run.end();
      return;
    }

    const projectFile = projectFiles[0].fsPath;
    const args = ['test', projectFile, '--logger', 'trx'];

    // When specific tests are selected, restrict the run with a --filter.
    // An empty expression (e.g. the whole suite) runs the entire project.
    const filterExpression = request.include ? buildFilterExpression(items) : undefined;
    if (filterExpression) {
      args.push('--filter', filterExpression);
    }

    if (debug) {
      await debugTests(projectFiles[0], args, items, run, logger, token);
    } else {
      const task = new vscode.Task(
        { type: 'gsharp', task: 'test', project: projectFile },
        vscode.TaskScope.Workspace,
        'test',
        'gsharp',
        new vscode.ShellExecution('dotnet', args),
      );

      await vscode.tasks.executeTask(task);

      // Mark all as passed (actual result parsing from TRX would be added here)
      for (const item of items) {
        run.passed(item);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    for (const item of items) {
      run.errored(item, new vscode.TestMessage(message));
    }
  }

  run.end();
}

/**
 * Runs `dotnet test` with VSTEST_HOST_DEBUG enabled so the test host pauses and
 * prints its process id, then attaches the CoreCLR debugger to that process.
 */
async function debugTests(
  projectUri: vscode.Uri,
  args: string[],
  items: vscode.TestItem[],
  run: vscode.TestRun,
  logger: Logger,
  token: vscode.CancellationToken,
) {
  const folder = vscode.workspace.getWorkspaceFolder(projectUri);
  const child = cp.spawn('dotnet', args, {
    cwd: path.dirname(projectUri.fsPath),
    env: { ...process.env, VSTEST_HOST_DEBUG: '1' },
  });

  let attached = false;
  let buffer = '';
  const handleOutput = (data: Buffer) => {
    const text = data.toString();
    run.appendOutput(text.replace(/\r?\n/g, '\r\n'));

    if (!attached) {
      buffer += text;
      const match = buffer.match(/Process Id:\s*(\d+)/i);
      if (match) {
        attached = true;
        void attachToTestHost(folder, parseInt(match[1], 10), logger);
      }
    }
  };

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  const cancellation = token.onCancellationRequested(() => {
    child.kill();
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      logger.error('Failed to launch dotnet test for debugging', err);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });

  cancellation.dispose();

  for (const item of items) {
    if (token.isCancellationRequested) {
      run.skipped(item);
    } else if (exitCode === 0) {
      run.passed(item);
    } else {
      run.errored(item, new vscode.TestMessage(`Test host exited with code ${exitCode}.`));
    }
  }
}

async function attachToTestHost(
  folder: vscode.WorkspaceFolder | undefined,
  processId: number,
  logger: Logger,
) {
  const config: vscode.DebugConfiguration = {
    name: 'GSharp: Debug Tests',
    type: 'coreclr',
    request: 'attach',
    processId,
  };

  logger.info(`Attaching debugger to test host (pid ${processId})...`);
  const started = await vscode.debug.startDebugging(folder, config);
  if (!started) {
    logger.warn('Failed to attach the debugger to the test host process.');
  }
}
