---
title: "VS Code extension"
sidebar_position: 3
draft: false
---

# VS Code extension

The G# VS Code extension provides language registration, syntax highlighting, snippets, themes, language-server integration, build/run commands, task definitions, and debugger configuration for `.gs` and `.gsproj` files.

## Install

The extension is published on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gsharplang.vscode-gsharp). Install it from the Extensions view in VS Code (search for "G#"), or from the command line:

```bash
code --install-extension gsharplang.vscode-gsharp
```

## Activation and file types

The extension activates when you open a G# file, when a workspace contains `.gs` or `.gsproj` files, when G# debug configuration is resolved, or when the restart-server command is invoked. It registers:

- language ID `gsharp` for `.gs` files, with aliases `GSharp` and `G#`;
- `.gsproj` as XML so project files get XML editing support;
- TextMate scope `source.gsharp` for syntax highlighting;
- breakpoint support for G# source files.

## Editor features

Rich language features come from the G# Language Server over LSP. In current source, the extension is a thin client and the server advertises diagnostics, hover, definition, type definition, implementation, references, document highlights, document symbols, workspace symbols, formatting, range formatting, on-type formatting, folding, selection ranges, linked editing, completion, signature help, rename, code actions, code lenses, semantic tokens, and inlay hints.

The extension also contributes snippets and six color themes inspired by the G# logo's amber-to-red palette: `GSharp Ember`, `GSharp Magma`, and `GSharp Synthwave`, each in a Dark and a Light variant. Dark variants use neon-on-dark accents while light variants use deep, high-contrast hues, and all of them theme the editor, explorer/sidebar, tab bar, activity bar, and status bar for a cohesive look.

## Settings

The extension contributes these settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `gsharp.server.path` | empty | Path to a G# Language Server executable. Empty means use the bundled server. |
| `gsharp.server.startTimeout` | `30000` | Milliseconds to wait for server startup. |
| `gsharp.server.waitForDebugger` | `false` | Passes the server debug option when starting the language server. |
| `gsharp.server.log` | `false` | Enables language-server protocol logging. |
| `gsharp.server.logPath` | empty | Optional log path. Empty lets the server choose its default log path. |
| `gsharp.trace.server` | `off` | VS Code language-client tracing: `off`, `messages`, or `verbose`. |
| `gsharp.formatting.indentSize` | `4` | Intended indentation size setting. Current server formatting uses its own implementation. |
| `gsharp.formatting.useTabs` | `false` | Intended tabs/spaces setting. Current server formatting uses its own implementation. |
| `gsharp.diagnostics.enableOnType` | `true` | Intended on-type diagnostics control. |
| `gsharp.completion.triggerOnDot` | `true` | Intended dot-trigger completion control. |
| `gsharp.codeLens.enableReferences` | `true` | Intended reference CodeLens control. |
| `gsharp.inlayHints.enableParameterNames` | `true` | Intended parameter-name hint control. |
| `gsharp.inlayHints.enableTypeHints` | `true` | Intended type-hint control. |

```json title="settings.json"
{
  "gsharp.server.log": true,
  "gsharp.trace.server": "messages",
  "gsharp.server.path": ""
}
```

## Commands

The extension contributes these command IDs and titles:

| Command ID | Title |
| --- | --- |
| `gsharp.restartServer` | GSharp: Restart Language Server |
| `gsharp.openOutput` | GSharp: Show Output Channel |
| `gsharp.buildProject` | GSharp: Build Project |
| `gsharp.runProject` | GSharp: Run Project |
| `gsharp.test.runInContext` | GSharp: Run Tests at Cursor |
| `gsharp.test.debugInContext` | GSharp: Debug Tests at Cursor |
| `gsharp.generateAssets` | GSharp: Generate Build & Debug Assets |
| `gsharp.fixAll.document` | GSharp: Fix All (Document) |
| `gsharp.fixAll.project` | GSharp: Fix All (Project) |
| `gsharp.reportIssue` | GSharp: Report Issue |

The default keybinding maps `Ctrl+Shift+B` on Windows/Linux and `Cmd+Shift+B` on macOS to `gsharp.buildProject` when the active editor is G#.

## Tasks

The extension contributes a `gsharp` task type with `task` values `build`, `run`, `test`, and `clean`, plus an optional `project` path.

```json title="tasks.json"
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build G# project",
      "type": "gsharp",
      "task": "build",
      "project": "MyApp.gsproj"
    }
  ]
}
```

## Debugging

G# emits normal managed .NET assemblies and Portable PDBs, so VS Code debugging uses the .NET CoreCLR debugger (`vsdbg`). The extension contributes a `gsharp` debug type but resolves launch configurations to `coreclr` with a `.dll` program path.

```json title="launch.json"
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch GSharp App",
      "type": "coreclr",
      "request": "launch",
      "preLaunchTask": "dotnet: build",
      "program": "${workspaceFolder}/bin/Debug/net10.0/MyApp.dll",
      "args": [],
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "stopAtEntry": false
    }
  ]
}
```

Install the .NET runtime/debugger dependencies required by your VS Code environment, build with Portable PDBs, then set breakpoints in `.gs` files as usual.
