import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerProjectCommands } from '../commands/projectCommands';
import { computeLaunchPaths } from '../utils/projectLayout';

describe('computeLaunchPaths', () => {
  it('roots paths at the project subdirectory for a solution layout', () => {
    const ws = path.join(path.sep, 'home', 'me', 'Temp');
    const project = path.join(ws, 'Temp', 'Temp.gsproj');

    const { program, cwd } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/Temp/bin/Debug/net10.0/Temp.dll');
    expect(cwd).toBe('${workspaceFolder}/Temp');
  });

  it('uses the workspace folder directly when the project is at the root', () => {
    const ws = path.join(path.sep, 'home', 'me', 'App');
    const project = path.join(ws, 'App.gsproj');

    const { program, cwd } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/bin/Debug/net10.0/App.dll');
    expect(cwd).toBe('${workspaceFolder}');
  });

  it('handles nested subdirectories', () => {
    const ws = path.join(path.sep, 'work', 'repo');
    const project = path.join(ws, 'src', 'Server', 'Server.gsproj');

    const { program } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/src/Server/bin/Debug/net10.0/Server.dll');
  });

  it('honors a custom target framework', () => {
    const ws = path.join(path.sep, 'w');
    const project = path.join(ws, 'Lib', 'Lib.gsproj');

    const { program } = computeLaunchPaths(ws, project, 'net9.0');

    expect(program).toBe('${workspaceFolder}/Lib/bin/Debug/net9.0/Lib.dll');
  });

  it('falls back to the workspace folder when the project is outside it', () => {
    const ws = path.join(path.sep, 'home', 'me', 'inside');
    const project = path.join(path.sep, 'home', 'me', 'outside', 'Other.gsproj');

    const { program, cwd } = computeLaunchPaths(ws, project);

    expect(program).toBe('${workspaceFolder}/bin/Debug/net10.0/Other.dll');
    expect(cwd).toBe('${workspaceFolder}');
  });

  it('uses AssemblyName and TargetFramework from the .gsproj file on disk (#5009)', () => {
    const ws = path.join(process.cwd(), `.fixture-5009-meta-${process.pid}`);
    const appDir = path.join(ws, 'src', 'Waikiki.App');
    const appProj = path.join(appDir, 'Waikiki.App.gsproj');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      appProj,
      [
        '<Project Sdk="Gsharp.NET.Sdk/0.4.1150">',
        '  <PropertyGroup>',
        '    <OutputType>Exe</OutputType>',
        '    <TargetFramework>net10.0</TargetFramework>',
        '    <AssemblyName>Waikiki</AssemblyName>',
        '  </PropertyGroup>',
        '</Project>',
      ].join('\n'),
    );

    try {
      const { program, cwd } = computeLaunchPaths(ws, appProj);
      expect(program).toBe('${workspaceFolder}/src/Waikiki.App/bin/Debug/net10.0/Waikiki.dll');
      expect(cwd).toBe('${workspaceFolder}/src/Waikiki.App');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('gsharp.generateAssets (#5009)', () => {
  function writeProject(filePath: string, body: string): { fsPath: string } {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);
    return { fsPath: filePath };
  }

  async function invokeGenerateAssets(): Promise<void> {
    const handlers = new Map<string, () => Promise<void>>();
    const origRegister = vscode.commands.registerCommand;
    (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand =
      ((command: string, callback: () => Promise<void>) => {
        handlers.set(command, callback);
        return { dispose: () => {} };
      }) as typeof vscode.commands.registerCommand;
    try {
      registerProjectCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      const handler = handlers.get('gsharp.generateAssets');
      expect(handler).toBeDefined();
      await handler!();
    } finally {
      (
        vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }
      ).registerCommand = origRegister;
    }
  }

  it('selects the single runnable Exe project over preceding libraries and uses AssemblyName + workspaceFolder-relative task args', async () => {
    const ws = path.join(process.cwd(), `.fixture-5009-waikiki-${process.pid}`);
    try {
      const mp4 = writeProject(
        path.join(ws, 'src', 'Waikiki.Mp4', 'Waikiki.Mp4.gsproj'),
        '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      const yoto = writeProject(
        path.join(ws, 'src', 'Waikiki.Yoto', 'Waikiki.Yoto.gsproj'),
        '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      const core = writeProject(
        path.join(ws, 'src', 'Waikiki.Core', 'Waikiki.Core.gsproj'),
        '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      const app = writeProject(
        path.join(ws, 'src', 'Waikiki.App', 'Waikiki.App.gsproj'),
        [
          '<Project Sdk="Gsharp.NET.Sdk">',
          '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>',
          '    <TargetFramework>net10.0</TargetFramework>',
          '    <AssemblyName>Waikiki</AssemblyName>',
          '  </PropertyGroup>',
          '</Project>',
        ].join('\n'),
      );

      const allProjects = [mp4, yoto, core, app];
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: ws } },
      ];
      (vscode.workspace as { findFiles: unknown }).findFiles = async (
        _include: unknown,
        _exclude?: unknown,
        maxResults?: number,
      ) => (typeof maxResults === 'number' ? allProjects.slice(0, maxResults) : allProjects);

      await invokeGenerateAssets();

      const launchJson = JSON.parse(
        fs.readFileSync(path.join(ws, '.vscode', 'launch.json'), 'utf8'),
      );
      const tasksJson = JSON.parse(
        fs.readFileSync(path.join(ws, '.vscode', 'tasks.json'), 'utf8'),
      );

      expect(launchJson.configurations[0]).toMatchObject({
        name: 'Launch Waikiki.App',
        preLaunchTask: 'dotnet: build',
        program: '${workspaceFolder}/src/Waikiki.App/bin/Debug/net10.0/Waikiki.dll',
        cwd: '${workspaceFolder}/src/Waikiki.App',
      });
      expect(tasksJson.tasks[0]).toMatchObject({
        label: 'dotnet: build',
        args: ['build', '${workspaceFolder}/src/Waikiki.App/Waikiki.App.gsproj'],
      });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('prompts the user via showQuickPick when multiple runnable projects exist', async () => {
    const ws = path.join(process.cwd(), `.fixture-5009-multi-${process.pid}`);
    try {
      const lib = writeProject(
        path.join(ws, 'src', 'Shared', 'Shared.gsproj'),
        '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      const cli = writeProject(
        path.join(ws, 'src', 'Cli', 'Cli.gsproj'),
        '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      const gui = writeProject(
        path.join(ws, 'src', 'Gui', 'Gui.gsproj'),
        '<Project Sdk="Gsharp.NET.Sdk"><PropertyGroup><OutputType>WinExe</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>GuiDesktop</AssemblyName></PropertyGroup></Project>',
      );

      const allProjects = [lib, cli, gui];
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: ws } },
      ];
      (vscode.workspace as { findFiles: unknown }).findFiles = async (
        _include: unknown,
        _exclude?: unknown,
        maxResults?: number,
      ) => (typeof maxResults === 'number' ? allProjects.slice(0, maxResults) : allProjects);

      let promptedLabels: string[] = [];
      const origQuickPick = vscode.window.showQuickPick;
      (vscode.window as { showQuickPick: unknown }).showQuickPick = async (
        items: Array<{ label: string }>,
      ) => {
        promptedLabels = items.map((i) => i.label);
        return items.find((i) => i.label === 'Gui');
      };

      try {
        await invokeGenerateAssets();
      } finally {
        (vscode.window as { showQuickPick: unknown }).showQuickPick = origQuickPick;
      }

      expect(promptedLabels).toEqual(['Cli', 'Gui']);
      const launchJson = JSON.parse(
        fs.readFileSync(path.join(ws, '.vscode', 'launch.json'), 'utf8'),
      );
      expect(launchJson.configurations[0]).toMatchObject({
        name: 'Launch Gui',
        program: '${workspaceFolder}/src/Gui/bin/Debug/net10.0/GuiDesktop.dll',
        cwd: '${workspaceFolder}/src/Gui',
      });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
