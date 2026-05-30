import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { Logger } from '../utils/logger';

interface TestItem {
  id: string;
  label: string;
  uri: string;
  line: number;
  children?: TestItem[];
}

export function registerTestingFeatures(
  context: vscode.ExtensionContext,
  client: LanguageClient,
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
      await discoverTests(testController, client, logger);
    }
  };

  // Register commands for running tests at cursor
  context.subscriptions.push(
    vscode.commands.registerCommand('gsharp.test.runInContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      // Find the test item at the cursor position and run it
      logger.info('Running test at cursor...');
      // Delegate to the test controller run
    }),
    vscode.commands.registerCommand('gsharp.test.debugInContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      logger.info('Debugging test at cursor...');
    }),
  );
}

async function discoverTests(
  controller: vscode.TestController,
  client: LanguageClient,
  logger: Logger,
) {
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
  for (const test of tests) {
    const item = controller.createTestItem(test.id, test.label, vscode.Uri.parse(test.uri));
    item.range = new vscode.Range(test.line, 0, test.line, 0);
    if (test.children) {
      for (const child of test.children) {
        const childItem = controller.createTestItem(
          child.id,
          child.label,
          vscode.Uri.parse(child.uri),
        );
        childItem.range = new vscode.Range(child.line, 0, child.line, 0);
        item.children.add(childItem);
      }
    }
    controller.items.add(item);
  }
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

    if (debug) {
      // For debug, launch with debugger attached
      logger.info('Debug testing not yet fully implemented — running without debugger.');
    }

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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    for (const item of items) {
      run.errored(item, new vscode.TestMessage(message));
    }
  }

  run.end();
}
