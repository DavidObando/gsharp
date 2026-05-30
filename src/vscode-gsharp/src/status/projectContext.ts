import * as vscode from 'vscode';

export class ProjectContext {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBarItem.name = 'GSharp Project';
    this.statusBarItem.tooltip = 'Active GSharp project';
  }

  async update() {
    const projectFiles = await vscode.workspace.findFiles('**/*.gsproj', '**/node_modules/**');
    if (projectFiles.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    if (projectFiles.length === 1) {
      const name = projectFiles[0].fsPath.split('/').pop()?.replace('.gsproj', '') || 'GSharp';
      this.statusBarItem.text = `$(project) ${name}`;
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = `$(project) ${projectFiles.length} projects`;
      this.statusBarItem.show();
    }
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}
