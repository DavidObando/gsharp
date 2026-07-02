import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { LanguageClient } from 'vscode-languageclient/node';
import { Logger } from '../utils/logger';
import { classifyOutcome, matchTrxResult, parseTrx, TrxTestResult } from './trx';

interface TestItem {
  id: string;
  label: string;
  uri: string;
  line: number;
  filter?: string;
  projectFile?: string;
  children?: TestItem[];
}

// Maps a vscode.TestItem id to its `dotnet test --filter "FullyQualifiedName~..."`
// token, as reported by the language server's gsharp/discoverTests response.
const testFilters = new Map<string, string>();

// Maps a vscode.TestItem id to the absolute path of the `.gsproj` that owns it, so a
// run targets the correct project. Project grouping nodes carry the path explicitly;
// nested items inherit it from their ancestor group during tree construction.
const itemProjects = new Map<string, string>();

export function registerTestingFeatures(
  context: vscode.ExtensionContext,
  getClient: () => LanguageClient | undefined,
  logger: Logger,
): { refresh: () => void } {
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

  // Keep the Test Explorer continuously in sync with the workspace. The server
  // discovers tests across every project source file (not just open buffers), so
  // re-running discovery on edits, opens, saves, and file-system changes is what
  // delivers live updates as the user types or builds. A debounce coalesces bursts
  // of keystrokes and lets the language server process the corresponding didChange
  // notifications before we re-query.
  let discoveryTimer: NodeJS.Timeout | undefined;
  const scheduleDiscovery = () => {
    if (discoveryTimer) {
      clearTimeout(discoveryTimer);
    }
    discoveryTimer = setTimeout(() => {
      discoveryTimer = undefined;
      void discoverTests(testController, getClient, logger);
    }, 400);
  };

  const isGSharp = (document: vscode.TextDocument) =>
    document.languageId === 'gsharp' || document.uri.fsPath.endsWith('.gs');

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isGSharp(e.document)) {
        scheduleDiscovery();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isGSharp(doc)) {
        scheduleDiscovery();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isGSharp(doc)) {
        scheduleDiscovery();
      }
    }),
    vscode.workspace.onDidCreateFiles(() => scheduleDiscovery()),
    vscode.workspace.onDidDeleteFiles(() => scheduleDiscovery()),
    vscode.workspace.onDidRenameFiles(() => scheduleDiscovery()),
  );

  // Catch source changes made outside the editor (e.g. branch switches, builds).
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.gs');
  watcher.onDidCreate(() => scheduleDiscovery());
  watcher.onDidDelete(() => scheduleDiscovery());
  watcher.onDidChange(() => scheduleDiscovery());
  context.subscriptions.push(watcher);

  // Register commands for running tests at cursor
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.test.runInContext', async () => {
      await runTestAtCursor(testController, getClient, logger, false);
    }),
    vscode.commands.registerCommand('gsharp.test.debugInContext', async () => {
      await runTestAtCursor(testController, getClient, logger, true);
    }),
  );

  return { refresh: scheduleDiscovery };
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
  itemProjects.clear();
  for (const test of tests) {
    const item = buildTestItem(controller, test, undefined);
    controller.items.add(item);
  }
}

function buildTestItem(
  controller: vscode.TestController,
  test: TestItem,
  inheritedProjectFile: string | undefined,
): vscode.TestItem {
  const item = controller.createTestItem(test.id, test.label, vscode.Uri.parse(test.uri));
  item.range = new vscode.Range(test.line, 0, test.line, 0);

  if (test.filter) {
    testFilters.set(test.id, test.filter);
  }

  const projectFile = test.projectFile ?? inheritedProjectFile;
  if (projectFile) {
    itemProjects.set(test.id, projectFile);
  }

  if (test.children) {
    for (const child of test.children) {
      item.children.add(buildTestItem(controller, child, projectFile));
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

  // Collect the top-level items the user asked to run (specific selection, or the
  // whole controller when no include is given).
  const items: vscode.TestItem[] = [];
  if (request.include) {
    request.include.forEach((item) => items.push(item));
  } else {
    controller.items.forEach((item) => items.push(item));
  }

  for (const item of items) {
    if (token.isCancellationRequested) break;
    forEachLeaf(item, (leaf) => run.started(leaf));
  }

  try {
    // Group the selection by the owning project so each `dotnet test` invocation runs
    // against the correct `.gsproj`. A multi-project workspace (e.g. several test
    // projects) would otherwise always run against an arbitrary first project.
    const groups = await groupItemsByProject(items);
    if (groups.size === 0) {
      for (const item of items) {
        forEachLeaf(item, (leaf) =>
          run.errored(leaf, new vscode.TestMessage('No .gsproj file found.')),
        );
      }
      run.end();
      return;
    }

    for (const [projectFile, group] of groups) {
      if (token.isCancellationRequested) break;
      // Omit the filter when running an entire project (the project group node, or a
      // bare "run all"); otherwise restrict the run to exactly the selected tests.
      const filterExpression = group.runAll ? undefined : buildFilterExpression(group.items);
      await runProject(projectFile, group.items, filterExpression, run, logger, debug, token);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    for (const item of items) {
      forEachLeaf(item, (leaf) => run.errored(leaf, new vscode.TestMessage(message)));
    }
  }

  run.end();
}

/**
 * Buckets the selected items by the absolute path of the `.gsproj` that owns them.
 * A top-level grouping node with no test filter of its own (i.e. a project group) marks
 * its bucket as "run all", so the whole project runs without a `--filter`. Items whose
 * project cannot be determined (loose files, or an older server) fall back to the first
 * `.gsproj` discovered in the workspace.
 */
async function groupItemsByProject(
  items: vscode.TestItem[],
): Promise<Map<string, { items: vscode.TestItem[]; runAll: boolean }>> {
  const groups = new Map<string, { items: vscode.TestItem[]; runAll: boolean }>();
  let fallback: string | undefined;

  for (const item of items) {
    let projectFile = projectFileForItem(item);
    if (!projectFile) {
      if (fallback === undefined) {
        const found = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**', 1);
        fallback = found.length > 0 ? found[0].fsPath : '';
      }
      projectFile = fallback;
    }

    if (!projectFile) {
      continue;
    }

    let group = groups.get(projectFile);
    if (!group) {
      group = { items: [], runAll: false };
      groups.set(projectFile, group);
    }

    group.items.push(item);
    if (!item.parent && !testFilters.has(item.id)) {
      group.runAll = true;
    }
  }

  return groups;
}

function projectFileForItem(item: vscode.TestItem): string | undefined {
  let current: vscode.TestItem | undefined = item;
  while (current) {
    const projectFile = itemProjects.get(current.id);
    if (projectFile) {
      return projectFile;
    }
    current = current.parent;
  }
  return undefined;
}

function forEachLeaf(item: vscode.TestItem, fn: (leaf: vscode.TestItem) => void) {
  if (item.children.size === 0) {
    fn(item);
    return;
  }
  item.children.forEach((child) => forEachLeaf(child, fn));
}

async function runProject(
  projectFile: string,
  items: vscode.TestItem[],
  filterExpression: string | undefined,
  run: vscode.TestRun,
  logger: Logger,
  debug: boolean,
  token: vscode.CancellationToken,
) {
  const leaves: vscode.TestItem[] = [];
  for (const item of items) {
    forEachLeaf(item, (leaf) => leaves.push(leaf));
  }

  // A dedicated, unique results directory + fixed file name gives a deterministic
  // path to the TRX file `dotnet test` writes, regardless of project name or
  // concurrent runs of other projects/tests.
  const resultsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsharp-test-'));
  const trxFileName = 'result.trx';
  const trxPath = path.join(resultsDirectory, trxFileName);

  const args = [
    'test',
    projectFile,
    '--logger',
    `trx;LogFileName=${trxFileName}`,
    '--results-directory',
    resultsDirectory,
  ];
  if (filterExpression) {
    args.push('--filter', filterExpression);
  }

  const projectUri = vscode.Uri.file(projectFile);

  try {
    const exitCode = debug
      ? await runDebugProcess(projectUri, args, run, logger, token)
      : await runTestProcess(projectUri, args, run, token);

    reportTrxResults(leaves, trxPath, exitCode, token, run);
  } finally {
    fs.rmSync(resultsDirectory, { recursive: true, force: true });
  }
}

/**
 * Runs `dotnet test` as a plain child process and awaits its actual exit (as opposed
 * to `vscode.tasks.executeTask`, which resolves once the task *starts*). Cancelling
 * the test run kills the process.
 */
async function runTestProcess(
  projectUri: vscode.Uri,
  args: string[],
  run: vscode.TestRun,
  token: vscode.CancellationToken,
): Promise<number> {
  const child = cp.spawn('dotnet', args, { cwd: path.dirname(projectUri.fsPath) });

  const handleOutput = (data: Buffer) => {
    run.appendOutput(data.toString().replace(/\r?\n/g, '\r\n'));
  };
  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  const cancellation = token.onCancellationRequested(() => child.kill());
  try {
    return await new Promise<number>((resolve) => {
      child.on('error', () => resolve(1));
      child.on('close', (code) => resolve(code ?? 0));
    });
  } finally {
    cancellation.dispose();
  }
}

/**
 * Runs `dotnet test` with VSTEST_HOST_DEBUG enabled so the test host pauses and
 * prints its process id, then attaches the CoreCLR debugger to that process.
 */
async function runDebugProcess(
  projectUri: vscode.Uri,
  args: string[],
  run: vscode.TestRun,
  logger: Logger,
  token: vscode.CancellationToken,
): Promise<number> {
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

  try {
    return await new Promise<number>((resolve) => {
      child.on('error', (err) => {
        logger.error('Failed to launch dotnet test for debugging', err);
        resolve(1);
      });
      child.on('close', (code) => resolve(code ?? 0));
    });
  } finally {
    cancellation.dispose();
  }
}

/**
 * Reads and parses the TRX file `dotnet test` produced and reports per-test outcomes.
 * Never marks a test as passed just because the process exited cleanly: a missing or
 * unparseable TRX file (e.g. the run crashed before writing it, or was cancelled) is
 * reported as an error/skip on every requested test instead of a false pass.
 */
function reportTrxResults(
  leaves: vscode.TestItem[],
  trxPath: string,
  exitCode: number,
  token: vscode.CancellationToken,
  run: vscode.TestRun,
) {
  let trxResults: TrxTestResult[] = [];
  let trxError: string | undefined;

  if (!fs.existsSync(trxPath)) {
    trxError = token.isCancellationRequested
      ? 'Test run was cancelled before results were produced.'
      : `No TRX results file was produced (dotnet test exited with code ${exitCode}).`;
  } else {
    try {
      trxResults = parseTrx(fs.readFileSync(trxPath, 'utf8'));
      if (trxResults.length === 0) {
        trxError = 'The TRX results file did not contain any test results.';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      trxError = `Failed to parse TRX results file: ${message}`;
    }
  }

  for (const leaf of leaves) {
    if (token.isCancellationRequested) {
      run.skipped(leaf);
      continue;
    }

    if (trxError) {
      run.errored(leaf, new vscode.TestMessage(trxError));
      continue;
    }

    const key = testFilters.get(leaf.id) ?? leaf.label;
    const result = matchTrxResult(key, trxResults);
    if (!result) {
      run.errored(
        leaf,
        new vscode.TestMessage(`No matching result found in TRX output for '${key}'.`),
      );
      continue;
    }

    const outcome = classifyOutcome(result.outcome);
    switch (outcome) {
      case 'passed':
        run.passed(leaf);
        break;
      case 'failed': {
        const text = result.stackTrace
          ? `${result.message ?? 'Test failed'}\n${result.stackTrace}`
          : (result.message ?? `Test failed: ${key}`);
        run.failed(leaf, new vscode.TestMessage(text));
        break;
      }
      case 'skipped':
        run.skipped(leaf);
        break;
      default:
        run.errored(
          leaf,
          new vscode.TestMessage(result.message ?? `Test outcome: ${result.outcome}`),
        );
        break;
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
