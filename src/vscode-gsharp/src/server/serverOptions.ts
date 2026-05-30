import * as vscode from 'vscode';

export function getServerOptions() {
  const config = vscode.workspace.getConfiguration('gsharp');
  return {
    path: config.get<string>('server.path', ''),
    startTimeout: config.get<number>('server.startTimeout', 30000),
    waitForDebugger: config.get<boolean>('server.waitForDebugger', false),
    trace: config.get<string>('trace.server', 'off'),
  };
}
