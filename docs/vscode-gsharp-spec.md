# VSCode Extension for GSharp — Technical Specification

This document specifies the design and implementation plan for a Visual Studio Code extension that provides rich language support for GSharp (`.gs` files, `.gsproj` projects). The spec is modeled after the architecture of the [C# for VS Code extension](https://github.com/dotnet/vscode-csharp), adapted to GSharp's toolchain.

## 1. Overview

| Property | Value |
| --- | --- |
| Extension ID | `gsharp.vscode-gsharp` |
| Display Name | GSharp |
| Categories | Programming Languages, Debuggers, Linters, Snippets |
| Extension Kind | `workspace` |
| Activation Events | `onLanguage:gsharp`, `workspaceContains:**/*.{gsproj,gs}`, `onDebugResolve:coreclr` |
| Main entry | `./dist/extension.js` |
| Language Server | `GSharp.LanguageServer` (existing .NET process, stdio transport) |

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  VS Code Extension (TypeScript)                                │
│                                                                │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────────────┐   │
│  │ Activation   │  │ LSP Client     │  │ Debug Adapter     │   │
│  │ & Lifecycle  │  │ (vscode-       │  │ Integration       │   │
│  │              │  │ languageclient)│  │                   │   │
│  └──────┬───────┘  └───────┬────────┘  └────────┬──────────┘   │
│         │                  │                    │              │
│  ┌──────┴───────┐  ┌───────┴────────┐  ┌────────┴──────────┐   │
│  │ Commands &   │  │ Middleware &   │  │ Launch Config     │   │
│  │ Settings     │  │ Feature Regs   │  │ Provider          │   │
│  └──────────────┘  └────────────────┘  └───────────────────┘   │
└────────────────────────────────────────────────────────────────┘
                           │ stdio / JSON-RPC
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  GSharp Language Server (.NET process)                         │
│  • StreamJsonRpc + hand-authored System.Text.Json protocol     │
│  • Document sync, completion, hover, go-to-def, references,    │
│    rename, code actions, signature help, document symbols,     │
│    folding, document highlight, diagnostics, semantic tokens   │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 Design Principles

1. **LSP-first**: All language intelligence flows through the GSharp Language Server via the Language Server Protocol. The extension is a thin client.
2. **Reuse .NET debugging**: GSharp compiles to standard .NET assemblies, so the existing `coreclr` debug adapter (vsdbg) works out of the box.
3. **Minimal runtime dependencies**: The extension bundles or acquires the GSharp Language Server binary; it depends on the .NET runtime extension for host resolution.
4. **Equivalent to C# extension**: Feature parity with the C# VS Code extension (where applicable to GSharp's language surface).

## 3. Extension Manifest (`package.json`)

### 3.1 Language Contribution

```jsonc
{
  "contributes": {
    "languages": [
      {
        "id": "gsharp",
        "aliases": ["GSharp", "G#"],
        "extensions": [".gs"],
        "configuration": "./language-configuration.json",
        "icon": {
          "light": "./images/gsharp-icon-light.png",
          "dark": "./images/gsharp-icon-dark.png"
        }
      }
    ]
  }
}
```

### 3.2 Grammar (TextMate)

A TextMate grammar (`syntaxes/gsharp.tmLanguage.json`) provides tokenization for syntax highlighting. The grammar should cover:

- Keywords (from `SyntaxFacts.GetKeywordKind` in the parser): `async`, `await`, `break`, `case`, `catch`, `chan`, `class`, `const`, `continue`, `default`, `defer`, `else`, `enum`, `fallthrough`, `false`, `finally`, `for`, `func`, `go`, `goto`, `if`, `import`, `interface`, `internal`, `is`, `let`, `map`, `nil`, `open`, `operator`, `override`, `package`, `private`, `public`, `range`, `return`, `scope`, `sealed`, `select`, `sequence`, `struct`, `switch`, `throw`, `true`, `try`, `type`, `using`, `var`, `with`, `yield`, `from`, `where`, `when`
- Contextual modifiers (matched as identifiers in the parser but colorized as `storage.modifier.gsharp`): `data`, `inline`, `record`, `delegate`, `event`, `prop`, `init`, `shared`, `partial`, `readonly`, `static`, `abstract`, `virtual`, `extern`, `scoped`
- Ref-kind modifiers: `ref`, `out` (and `in` as a clause keyword via `keyword.control.gsharp`)
- Accessor names (inside property/event bodies): `get`, `set`, `add`, `remove`, `raise`
- Built-in types (from `TypeSymbol` statics): `bool`, `uint8`, `int8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `nint`, `nuint`, `float32`, `float64`, `decimal`, `char`, `string`, `object`, `void`
- Operators: arithmetic, comparison, logical, assignment, bitwise, plus G#-specific `?.` (null-conditional), `??`/`??=` (null-coalescing), `?` and `:` (ternary, ADR-0062), `!!` (null-forgiving), `...` (range), `->` (switch arm), `=>` (lambda arrow). The `:=` token continues to be lexed so the parser can emit `GS0305`; the legacy short variable-declaration form was removed by ADR-0077.
- Literals: integers (with `lLuU` suffixes), floats (with `fFdDmM` suffixes), hex (`0x`), binary (`0b`), strings (interpreted and raw-backtick), characters
- Comments: `//` line comments, `/* … */` block comments (`ReadMultiLineComment`), and `///` documentation comments (`ReadDocumentationComment`, ADR-0057). Doc comments are scoped `comment.line.documentation.gsharp` and additionally highlight the `@summary`, `@param`, `@typeparam`, `@returns`, `@value`, `@remarks`, `@exception`, `@seealso`, `@inheritdoc` block tags.
- Annotations: `@Identifier(args)` patterns scoped `meta.annotation.gsharp` with the leading `@` as `punctuation.definition.annotation.gsharp` and the name as `storage.type.annotation.gsharp`.
- Identifiers, function calls, type annotations

G# is sigil-free for interpolation (ADR-0055): interpolation lives inside an ordinary interpreted string `"…"`, not a `$"…"` literal. The `strings` repository therefore distinguishes two forms and emits these scopes:

- `string.quoted.double.gsharp` — an interpreted `"…"` string. `applyEndPatternLast` is set so a doubled-quote escape `""` (`constant.character.escape.quote.gsharp`) is consumed before the closing `"`. A literal-`$` escape `$$` is `constant.character.escape.dollar.gsharp`.
- `string.quoted.raw.backtick.gsharp` — a raw backtick string `` `…` ``; it is **non-interpolating** (no `$` patterns apply inside it).
- `variable.other.interpolation.gsharp` — the identifier of a `$ident` hole; the `$` is `punctuation.definition.interpolation.begin.gsharp`.
- `meta.interpolation.gsharp` — a `${ … }` hole. `${` / `}` are `punctuation.definition.interpolation.begin/end.gsharp`; the body recursively includes `source.gsharp`, so the hole expression is highlighted as real code (and a nested `"…"` literal or balanced inner `{ … }` block does not prematurely end the hole). Inside the hole, an alignment clause `,-?N` is `constant.numeric.alignment.gsharp` and a format clause `:fmt` is `string.unquoted.format.gsharp`.


```jsonc
{
  "contributes": {
    "grammars": [
      {
        "language": "gsharp",
        "scopeName": "source.gsharp",
        "path": "./syntaxes/gsharp.tmLanguage.json"
      }
    ]
  }
}
```

### 3.3 Snippets

Provide a `snippets/gsharp.json` file with common patterns:

| Prefix | Description |
| --- | --- |
| `pkg` | `package` + `import` header |
| `fn` | Function declaration |
| `afn` | Async function declaration |
| `extfn` | Extension function (receiver clause) |
| `lambda` | Anonymous `func(...)` literal |
| `main` | Explicit `Main` entry point |
| `if` | If statement |
| `ife` | If/else statement |
| `for` | C-style for loop |
| `forin` | For-range over a sequence |
| `while` | While loop (`for cond { … }`) |
| `class` | Class declaration (`class X { … }`) |
| `classp` | Class with primary constructor |
| `struct` | Struct declaration |
| `datastruct` | `data struct` (value-semantics record) |
| `inlinestruct` | `inline struct(field T)` wrapper |
| `record` | Record declaration |
| `enum` | Enum declaration |
| `interface` | Interface declaration |
| `delegate` | Named delegate type (ADR-0059) |
| `prop` | Property with explicit `get`/`set` |
| `autoprop` | Auto-implemented property |
| `event` | Event declaration |
| `shared` | `shared { … }` block (per-type static) |
| `match` | `switch` with brace-block cases |
| `matchexpr` | Switch *expression* with `->` arms |
| `ternary` | Generalized ternary (ADR-0062) |
| `try` | Try/catch block |
| `defer` | Deferred call |
| `go` | Spawn a concurrent call |
| `scope` | Structured-concurrency scope |
| `select` | Channel `select` statement |
| `chan` | `make(chan T)` channel creation |
| `using` | Scoped resource (Dispose at exit) |
| `refparam` | Function with a `ref` parameter (ADR-0060) |
| `outparam` | Function with an `out` parameter (ADR-0060) |
| `letref` | `let ref` aliasing local |
| `doc` | Documentation comment (ADR-0057) |
| `ann` | Kotlin-style annotation |

### 3.4 Themes

Ship six bundled color themes inspired by the G# logo, optimized for GSharp's semantic token types. Each palette ships a dark and light variant:

- `GSharp Ember Dark` / `GSharp Ember Light` — warm reds and amber glows.
- `GSharp Magma Dark` / `GSharp Magma Light` — saturated lava palette.
- `GSharp Synthwave Dark` / `GSharp Synthwave Light` — high-contrast neon pinks/cyans.

### 3.5 Configuration Settings


```jsonc
{
  "contributes": {
    "configuration": [
      {
        "title": "GSharp",
        "properties": {
          "gsharp.server.path": {
            "type": "string",
            "default": "",
            "description": "Path to the GSharp Language Server executable. If empty, uses the bundled server."
          },
          "gsharp.server.startTimeout": {
            "type": "number",
            "default": 30000,
            "description": "Timeout in ms for the language server to start."
          },
          "gsharp.server.waitForDebugger": {
            "type": "boolean",
            "default": false,
            "description": "Pass --debug flag to the language server to wait for a debugger to attach."
          },
          "gsharp.server.log": {
            "type": "boolean",
            "default": false,
            "description": "Enable language server protocol logging to a file (passes --log to the server)."
          },
          "gsharp.server.logPath": {
            "type": "string",
            "default": "",
            "description": "Optional file path for the language server log. If empty, a default temporary file is used. Only used when gsharp.server.log is enabled."
          },
          "gsharp.trace.server": {
            "type": "string",
            "enum": ["off", "messages", "verbose"],
            "default": "off",
            "description": "Trace communication between VS Code and the GSharp language server."
          },
          "gsharp.formatting.indentSize": {
            "type": "number",
            "default": 4,
            "description": "Number of spaces per indentation level."
          },
          "gsharp.formatting.useTabs": {
            "type": "boolean",
            "default": false,
            "description": "Use tabs instead of spaces for indentation."
          },
          "gsharp.diagnostics.enableOnType": {
            "type": "boolean",
            "default": true,
            "description": "Run diagnostics as you type (on every keystroke)."
          },
          "gsharp.completion.triggerOnDot": {
            "type": "boolean",
            "default": true,
            "description": "Trigger auto-completion after typing a dot."
          },
          "gsharp.codeLens.enableReferences": {
            "type": "boolean",
            "default": true,
            "description": "Show reference counts above functions and types."
          },
          "gsharp.inlayHints.enableParameterNames": {
            "type": "boolean",
            "default": true,
            "description": "Show inlay hints for parameter names at call sites."
          },
          "gsharp.inlayHints.enableTypeHints": {
            "type": "boolean",
            "default": true,
            "description": "Show inlay hints for inferred variable types."
          }
        }
      }
    ]
  }
}
```

### 3.6 Commands

| Command ID | Title | When |
| --- | --- | --- |
| `gsharp.restartServer` | GSharp: Restart Language Server | always |
| `gsharp.openOutput` | GSharp: Show Output Channel | always |
| `gsharp.buildProject` | GSharp: Build Project | `workspaceContains:**/*.gsproj` |
| `gsharp.runProject` | GSharp: Run Project | `workspaceContains:**/*.gsproj` |
| `gsharp.test.runInContext` | GSharp: Run Tests at Cursor | `editorLangId == gsharp` |
| `gsharp.test.debugInContext` | GSharp: Debug Tests at Cursor | `editorLangId == gsharp` |
| `gsharp.generateAssets` | GSharp: Generate Build & Debug Assets | `workspaceContains:**/*.gsproj` |
| `gsharp.fixAll.document` | GSharp: Fix All (Document) | `editorLangId == gsharp` |
| `gsharp.fixAll.project` | GSharp: Fix All (Project) | `workspaceContains:**/*.gsproj` |
| `gsharp.reportIssue` | GSharp: Report Issue | always |

### 3.7 Keybindings

| Key | Command | When |
| --- | --- | --- |
| `Ctrl+Shift+B` (platform default) | `gsharp.buildProject` | `editorLangId == gsharp` |

### 3.8 Debugger Contribution

```jsonc
{
  "contributes": {
    "debuggers": [
      {
        "type": "gsharp",
        "label": "GSharp",
        "runtime": "node",
        "languages": ["gsharp"],
        "configurationAttributes": {
          "launch": {
            "required": ["program"],
            "properties": {
              "program": { "type": "string", "description": "Path to the .dll to debug" },
              "args": { "type": "array", "items": { "type": "string" } },
              "cwd": { "type": "string" },
              "console": { "type": "string", "enum": ["internalConsole", "integratedTerminal", "externalTerminal"] },
              "stopAtEntry": { "type": "boolean", "default": false }
            }
          },
          "attach": {
            "properties": {
              "processId": { "type": ["number", "string"] }
            }
          }
        },
        "configurationSnippets": [
          {
            "label": "GSharp: Launch",
            "description": "Launch a GSharp application",
            "body": {
              "name": "Launch GSharp App",
              "type": "coreclr",
              "request": "launch",
              "preLaunchTask": "dotnet: build",
              "program": "^\"\\${workspaceFolder}/bin/Debug/net10.0/${1:AppName}.dll\"",
              "args": [],
              "cwd": "^\"\\${workspaceFolder}\"",
              "console": "integratedTerminal",
              "stopAtEntry": false
            }
          }
        ]
      }
    ],
    "breakpoints": [
      { "language": "gsharp" }
    ]
  }
}
```

The `gsharp` debug type is a thin wrapper that resolves to `coreclr` (vsdbg) since GSharp compiles to standard .NET assemblies. The extension provides a `DebugConfigurationProvider` that:

1. Auto-detects the output `.dll` path from the `.gsproj`
2. Generates `launch.json` snippets
3. Resolves the `gsharp` type to `coreclr` with appropriate settings

#### Debugger Acquisition Strategy

The .NET CoreCLR debugger (vsdbg) is a platform-specific native binary (~50MB). The C# extension bundles it by declaring download URLs in `package.json` under `runtimeDependencies` and fetching the appropriate platform zip on first activation.

**Phase 1–3 (MVP through Testing):** Depend on the C# extension for debugging. Declare `"extensionDependencies": ["ms-dotnettools.csharp"]` so vsdbg and the `coreclr` debug type are already registered. The GSharp extension simply emits `"type": "coreclr"` in launch configurations. This avoids duplicating the ~50MB binary and the download/integrity-check infrastructure.

**Phase 4+ (Standalone):** Remove the hard dependency on the C# extension and acquire vsdbg independently, using the same `runtimeDependencies` pattern:

```jsonc
{
  "runtimeDependencies": [
    {
      "id": "Debugger",
      "description": ".NET Core Debugger (macOS / arm64)",
      "url": "https://vsdebugger-cyg0dxb6czfafzaz.b01.azurefd.net/coreclr-debug-<version>/coreclr-debug-osx-arm64.zip",
      "installPath": ".debugger/arm64",
      "platforms": ["darwin"],
      "architectures": ["arm64"],
      "installTestPath": "./.debugger/arm64/vsdbg",
      "integrity": "<SHA256>"
    }
    // ... one entry per platform/arch combination
  ]
}
```

The extension activation flow:
1. Read `runtimeDependencies` from `package.json`, filter by current platform/architecture.
2. Check `installTestPath` — if the file exists, debugger is already installed.
3. If missing, download the zip from `url`, verify SHA-256 integrity, extract to `installPath`.
4. Register the `coreclr` debug configuration provider pointing at the extracted vsdbg binary.

This mirrors exactly how the C# extension (`src/installRuntimeDependencies.ts` + `src/coreclrDebug/activate.ts`) handles it. The vsdbg download URLs are public, versioned, and stable.

### 3.9 Task Definitions

```jsonc
{
  "contributes": {
    "taskDefinitions": [
      {
        "type": "gsharp",
        "required": ["task"],
        "properties": {
          "task": { "type": "string", "enum": ["build", "run", "test", "clean"] },
          "project": { "type": "string", "description": "Path to .gsproj file" }
        }
      }
    ]
  }
}
```

### 3.10 Activation Events

```jsonc
{
  "activationEvents": [
    "onLanguage:gsharp",
    "workspaceContains:**/*.{gsproj,gs}",
    "onDebugResolve:gsharp",
    "onDebugResolve:coreclr",
    "onCommand:gsharp.restartServer"
  ]
}
```

## 4. Language Server Integration

### 4.1 Server Lifecycle

The extension manages the GSharp Language Server process:

1. **Discovery**: Check `gsharp.server.path` setting → fall back to bundled server at `<extensionPath>/.server/GSharp.LanguageServer.dll`.
2. **Host runtime**: Use the `.NET Install Tool` extension (`ms-dotnettools.vscode-dotnet-runtime`) to acquire or locate a compatible .NET runtime.
3. **Launch**: Spawn via `dotnet <serverPath>` with stdio transport.
4. **Initialization**: Send LSP `initialize` with client capabilities; receive server capabilities.
5. **Shutdown**: On extension deactivation or explicit restart, send `shutdown` → `exit`.
6. **Crash recovery**: If the server process exits unexpectedly, attempt restart up to 5 times with exponential backoff.

### 4.2 Transport

- **Protocol**: JSON-RPC 2.0 over stdio (stdin/stdout)
- **Library**: `vscode-languageclient` (same as C# extension)

### 4.3 Currently Implemented LSP Features (Server Side)

The GSharp Language Server already implements these handlers:

| LSP Method | Handler | Status |
| --- | --- | --- |
| `textDocument/didOpen`, `didChange`, `didClose` | `DocumentSyncHandler` | ✅ Implemented |
| `textDocument/hover` | `HoverHandler` | ✅ Implemented |
| `textDocument/completion` | `CompletionHandler` | ✅ Implemented |
| `textDocument/signatureHelp` | `SignatureHelpHandler` | ✅ Implemented |
| `textDocument/definition` | `DefinitionHandler` | ✅ Implemented |
| `textDocument/references` | `ReferencesHandler` | ✅ Implemented |
| `textDocument/documentSymbol` | `DocumentSymbolHandler` | ✅ Implemented |
| `textDocument/documentHighlight` | `DocumentHighlightHandler` | ✅ Implemented |
| `textDocument/rename` | `RenameHandler` | ✅ Implemented |
| `textDocument/codeAction` | `CodeActionHandler` | ✅ Implemented |
| `textDocument/foldingRange` | `FoldingHandler` | ✅ Implemented |

### 4.4 LSP Features To Implement (Server Side)

These features need to be added to the GSharp Language Server to reach parity with the C# extension:

| LSP Method | Priority | Description |
| --- | --- | --- |
| `textDocument/publishDiagnostics` | P0 | Push diagnostics (errors/warnings) to the client |
| `textDocument/formatting` | P0 | Format entire document |
| `textDocument/rangeFormatting` | P1 | Format selection |
| `textDocument/onTypeFormatting` | P1 | Format on `;`, `}`, newline |
| `textDocument/semanticTokens/full` | P0 | Semantic token highlighting |
| `textDocument/semanticTokens/range` | P1 | Semantic tokens for visible range |
| `textDocument/inlayHint` | P1 | Parameter name / type inlay hints |
| `textDocument/codeLens` | P1 | Reference counts, run/debug test lenses |
| `textDocument/prepareRename` | P2 | Validate rename position |
| `workspace/symbol` | P1 | Workspace-wide symbol search |
| `textDocument/implementation` | P2 | Go to implementation |
| `textDocument/typeDefinition` | P2 | Go to type definition |
| `textDocument/selectionRange` | P2 | Smart selection expansion |
| `textDocument/linkedEditingRange` | P3 | Linked editing (rename pairs) |
| `workspace/didChangeWatchedFiles` | P1 | React to file system changes |
| `textDocument/diagnostic` (pull model) | P2 | Pull-based diagnostics |

### 4.5 Semantic Token Types

Define semantic token types matching GSharp's type system:

| Token Type | Description |
| --- | --- |
| `namespace` | Package names |
| `type` | Class, struct, enum, interface names |
| `typeParameter` | Generic type parameters |
| `parameter` | Function parameters |
| `variable` | Local variables |
| `property` | Object properties/fields |
| `function` | Function declarations and references |
| `method` | Method declarations and references |
| `keyword` | Language keywords |
| `string` | String literals |
| `number` | Numeric literals |
| `operator` | Operators |
| `comment` | Comments |
| `enum` | Enum type names |
| `enumMember` | Enum members |
| `interface` | Interface type names |
| `struct` | Struct type names |

Modifiers: `declaration`, `definition`, `readonly`, `static`, `async`, `deprecated`.

## 5. Extension Client Features (TypeScript)

### 5.1 Module Structure

```
src/
├── extension.ts              # activate() / deactivate() entry point
├── server/
│   ├── serverManager.ts      # Start/stop/restart language server
│   ├── serverOptions.ts      # Configuration reading
│   └── serverDownloader.ts   # Download/update server binaries
├── features/
│   ├── diagnostics.ts        # Diagnostic display & fix-all commands
│   ├── testing.ts            # Test explorer integration
│   ├── formatting.ts         # On-type formatting middleware
│   ├── inlayHints.ts         # Inlay hint toggle & refresh
│   ├── codeLens.ts           # CodeLens management
│   └── autoInsert.ts         # Auto-close brackets, XML doc, etc.
├── debugger/
│   ├── configProvider.ts     # Debug configuration resolution
│   ├── launchProvider.ts     # Auto-generate launch.json
│   └── assetGenerator.ts     # tasks.json + launch.json generation
├── commands/
│   ├── buildCommands.ts      # Build/run/clean commands
│   ├── serverCommands.ts     # Restart, show output
│   └── projectCommands.ts    # Open project, restore, etc.
├── status/
│   ├── serverStatus.ts       # Language status item (loading/ready/error)
│   └── projectContext.ts     # Active project indicator
├── telemetry/
│   └── reporter.ts           # Optional anonymous telemetry
└── utils/
    ├── platform.ts           # OS/arch detection
    ├── dotnetResolver.ts     # .NET runtime resolution
    └── logger.ts             # Output channel logging
```

### 5.2 Activation Flow

```typescript
export async function activate(context: vscode.ExtensionContext) {
  // 1. Create output channels
  const outputChannel = vscode.window.createOutputChannel('GSharp', { log: true });
  const traceChannel = vscode.window.createOutputChannel('GSharp LSP Trace', { log: true });

  // 2. Detect platform & resolve .NET runtime
  const platform = await PlatformInformation.getCurrent();
  const dotnetPath = await resolveDotnetRuntime(context, platform);

  // 3. Resolve language server path
  const serverPath = getServerPath(context, platform);

  // 4. Create and start LSP client
  const serverOptions: ServerOptions = {
    run: { command: dotnetPath, args: [serverPath], transport: TransportKind.stdio },
    debug: { command: dotnetPath, args: [serverPath, '--debug'], transport: TransportKind.stdio }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'gsharp' }],
    outputChannel,
    traceOutputChannel: traceChannel,
    middleware: { /* formatting, diagnostics, etc. */ }
  };

  const client = new LanguageClient('gsharp', 'GSharp Language Server', serverOptions, clientOptions);
  await client.start();

  // 5. Register commands, debugger, status items
  registerCommands(context, client);
  registerDebugger(context, client, platform);
  registerStatusItems(context, client);
  registerTestingFeatures(context, client);
}
```

### 5.3 Server Binary Management

The extension bundles the GSharp Language Server as a platform-specific binary (or DLL + runtime):

| Platform | Binary |
| --- | --- |
| Windows x64 | `.server/GSharp.LanguageServer.exe` |
| macOS x64/arm64 | `.server/GSharp.LanguageServer` (self-contained) or `.server/GSharp.LanguageServer.dll` |
| Linux x64/arm64 | `.server/GSharp.LanguageServer` (self-contained) or `.server/GSharp.LanguageServer.dll` |

If shipping framework-dependent (`.dll`), require the .NET runtime extension as a dependency:

```jsonc
{
  "extensionDependencies": ["ms-dotnettools.vscode-dotnet-runtime"]
}
```

### 5.4 Debugger Integration

Since GSharp targets produce standard .NET assemblies, debugging uses the existing CoreCLR debugger:

1. **DebugConfigurationProvider**: Resolves `gsharp` launch configs to `coreclr` by:
   - Reading the `.gsproj` to determine output path and target framework
   - Setting `program` to the compiled DLL path
   - Setting `cwd` to the project directory
2. **Asset Generation**: Command `gsharp.generateAssets` creates `.vscode/tasks.json` (with `dotnet build`) and `.vscode/launch.json`.
3. **Build-before-debug**: Pre-launch tasks invoke `dotnet build` on the `.gsproj`.

### 5.5 Test Explorer Integration

Integrate with VS Code's Testing API (`vscode.TestController`):

1. Discover test files and methods via the language server (custom LSP request `gsharp/discoverTests`). Discovery is workspace-wide: the server scans every source file across all discovered projects (not just open editor buffers), overlaying open buffers so unsaved edits win, so the Test Explorer is fully populated after a build even before any file is opened.
2. Build a grouped `TestItem` hierarchy: a top-level node per project labelled `<project-name> (<tfm>)` (e.g. `Oahu.Cli.Tests (net10.0)`), matching the C# Dev Kit presentation, with a middle grouping node per test class labelled with its fully-qualified type name `<namespace>.<class>` (e.g. `Oahu.Cli.Tests.App.CredentialStoreTests`), and the individual test methods beneath it.
3. Run tests via `dotnet test` on the owning project's `.gsproj` (each project group carries its project path, so multi-project workspaces run against the correct project).
4. Parse test results and map back to source locations
5. Support CodeLens "Run Test | Debug Test" above test functions
6. Keep the Test Explorer live: re-run discovery (debounced) on document edits/opens/saves and on `.gs` file-system create/delete/change events, plus an initial discovery once the language server is ready.

### 5.6 Build Diagnostics

In addition to LSP-pushed diagnostics from the language server (which cover syntax and semantic errors in open files), the extension should also:

1. Monitor `dotnet build` output for errors/warnings
2. Parse MSBuild-format diagnostic lines (`file(line,col): error CODE: message`)
3. Push build diagnostics to a separate `DiagnosticCollection` so they don't conflict with live analysis

### 5.7 Status Bar & Language Status

- **Language Status Item**: Shows server state (Starting → Ready → Error) with a spinner during initialization
- **Project Context Status**: Shows the active project name when multiple `.gsproj` files exist in the workspace

## 6. Language Configuration

`language-configuration.json`:

```jsonc
{
  "comments": {
    "lineComment": "//",
  },
  "brackets": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"]
  ],
  "autoClosingPairs": [
    { "open": "{", "close": "}" },
    { "open": "[", "close": "]" },
    { "open": "(", "close": ")" },
    { "open": "\"", "close": "\"", "notIn": ["string"] },
    { "open": "'", "close": "'", "notIn": ["string"] }
  ],
  "surroundingPairs": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["\"", "\""],
    ["'", "'"]
  ],
  "folding": {
    "markers": {
      "start": "^\\s*//\\s*#region\\b",
      "end": "^\\s*//\\s*#endregion\\b"
    }
  },
  "indentationRules": {
    "increaseIndentPattern": "^.*\\{[^}\"']*$",
    "decreaseIndentPattern": "^\\s*\\}"
  },
  "wordPattern": "[a-zA-Z_][a-zA-Z0-9_]*",
  "onEnterRules": [
    {
      "beforeText": "^\\s*///.*$",
      "action": { "indent": "none", "appendText": "/// " }
    },
    {
      "beforeText": "\\{\\s*$",
      "action": { "indent": "indent" }
    }
  ]
}
```

## 7. Testing Strategy

### 7.1 Unit Tests

- Framework: Jest (TypeScript)
- Coverage: Configuration parsing, path resolution, command registration, diagnostic mapping
- Mocking: `vscode` API via `@vscode/test-electron` mocks

### 7.2 Integration Tests

- Launch VS Code with the extension loaded
- Open a GSharp workspace with sample `.gs` files
- Verify:
  - Language server starts and reaches ready state
  - Syntax highlighting applies correctly
  - Completion, hover, go-to-definition work end-to-end
  - Diagnostics appear for syntax/semantic errors
  - Debugging launches and hits breakpoints
  - Build command produces output

### 7.3 CI Pipeline

- GitHub Actions workflow
- Matrix: Windows, macOS, Linux × (x64, arm64 where available)
- Steps: `npm ci` → `npm run compile` → `npm run test:unit` → `npm run test:integration`

## 8. Packaging & Distribution

### 8.1 VSIX Structure

```
vscode-gsharp-<version>.vsix
├── extension/
│   ├── dist/extension.js          # Bundled extension (esbuild)
│   ├── .server/                   # Platform-specific language server
│   ├── syntaxes/gsharp.tmLanguage.json
│   ├── snippets/gsharp.json
│   ├── themes/gsharp-dark.json
│   ├── themes/gsharp-light.json
│   ├── language-configuration.json
│   ├── images/
│   └── package.json
└── [Content_Types].xml
```

### 8.2 Platform-Specific VSIXes

Like the C# extension, produce platform-specific VSIXes to include the native language server binary:

| Platform | VSIX suffix |
| --- | --- |
| Windows x64 | `win32-x64` |
| Windows arm64 | `win32-arm64` |
| macOS x64 | `darwin-x64` |
| macOS arm64 | `darwin-arm64` |
| Linux x64 | `linux-x64` |
| Linux arm64 | `linux-arm64` |
| Universal (DLL only) | (none) |

### 8.3 Build Tooling

- **Bundler**: esbuild (tree-shakes and bundles TypeScript → single JS file)
- **Package**: `@vscode/vsce` for VSIX creation
- **Versioning**: `nerdbank-gitversioning` or semver from `version.json`

## 9. Dependencies

### 9.1 Runtime Dependencies

| Package | Purpose |
| --- | --- |
| `vscode-languageclient` | LSP client implementation |
| `semver` | Version comparison for runtime/server |

### 9.2 Dev Dependencies

| Package | Purpose |
| --- | --- |
| `typescript` | Language |
| `esbuild` | Bundling |
| `@types/vscode` | VS Code API types |
| `@vscode/test-electron` | Integration test runner |
| `@vscode/vsce` | VSIX packaging |
| `jest` / `ts-jest` | Unit testing |
| `eslint` + `prettier` | Linting & formatting |

### 9.3 Extension Dependencies

| Extension | Purpose | Phase |
| --- | --- | --- |
| `ms-dotnettools.vscode-dotnet-runtime` | .NET runtime acquisition (for framework-dependent language server) | All |
| `ms-dotnettools.csharp` | Provides vsdbg debugger and `coreclr` debug type | Phase 1–3 only |

In Phase 4+, the dependency on `ms-dotnettools.csharp` is removed and the extension acquires vsdbg independently via `runtimeDependencies`.

## 10. Telemetry

Optional, anonymous telemetry using `@vscode/extension-telemetry`:

| Event | Data |
| --- | --- |
| `extension/activate` | Platform, extension version, server version |
| `server/start` | Startup time (ms) |
| `server/crash` | Exit code, restart count |
| `feature/used` | Feature name (completion, rename, etc.) — no content |

Telemetry respects the user's `telemetry.telemetryLevel` setting.

## 11. Roadmap / Phased Delivery

### Phase 0 — Prerequisites

- [ ] **Multi-file and multi-project workspace support in the Language Server** ([#281](https://github.com/DavidObando/gsharp/issues/281)): The language server must support project-level compilation (all `.gs` files in a `.gsproj` compiled together) with cross-file go-to-definition, references, rename, and completion. Without this, the extension can only provide single-file editing.

### Phase 1 — MVP (v0.1)

- [x] Language registration (`.gs` files recognized)
- [x] TextMate grammar for syntax highlighting
- [x] Language configuration (brackets, comments, indentation)
- [x] LSP client connecting to bundled GSharp Language Server
- [x] Hover, completion, go-to-definition, references, rename
- [x] Document symbols, document highlight, folding
- [x] Code actions (quick fixes)
- [x] Signature help
- [ ] Push diagnostics (errors/warnings as you type)
- [ ] Snippets

### Phase 2 — Rich Editing (v0.2)

- [ ] Semantic tokens (full semantic highlighting)
- [ ] Document formatting & range formatting
- [ ] On-type formatting
- [ ] Inlay hints (parameter names, inferred types)
- [ ] CodeLens (references, test run/debug)
- [ ] Workspace symbol search

### Phase 3 — Debugging & Testing (v0.3)

- [ ] Debug configuration provider (`gsharp` → `coreclr`)
- [ ] Auto-generate `launch.json` and `tasks.json`
- [ ] Test explorer integration
- [ ] Build command integration
- [ ] Build diagnostics (from `dotnet build` output)

### Phase 4 — Polish & Ecosystem (v0.4+)

- [ ] Platform-specific VSIX packaging
- [ ] Telemetry
- [ ] Color themes
- [ ] Go to implementation / type definition
- [ ] Selection range / smart select
- [ ] Linked editing
- [ ] Pull diagnostics model
- [ ] Copilot context providers (if applicable)
- [ ] Multi-root workspace support
- [ ] Localization (l10n)

## 12. Repository Structure

```
vscode-gsharp/
├── .vscode/                    # Extension development settings
├── .github/workflows/          # CI/CD
├── src/                        # TypeScript source
├── syntaxes/                   # TextMate grammars
├── snippets/                   # Code snippets
├── themes/                     # Color themes
├── images/                     # Icons
├── l10n/                       # Localization bundles
├── test/                       # Unit + integration tests
├── scripts/                    # Build/package scripts
├── language-configuration.json
├── package.json
├── tsconfig.json
├── esbuild.js
├── .eslintrc.js
├── .prettierrc
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## 13. Key Differences from C# Extension

| Aspect | C# Extension | GSharp Extension |
| --- | --- | --- |
| Language Server | Roslyn (closed-source binary) | GSharp.LanguageServer (in-repo, open source) |
| Legacy support | OmniSharp fallback path | Not needed (single server) |
| Razor/XAML | Additional embedded languages | Not applicable |
| DevKit integration | Optional proprietary companion | Not applicable |
| Debug adapter | Bundled vsdbg | Reuses vsdbg via `coreclr` type |
| Server framework | Custom LSP implementation | StreamJsonRpc + hand-authored System.Text.Json protocol |
| Project system | .sln/.csproj complex resolution | Single `.gsproj` per workspace (simpler) |
| Service broker | Inter-process brokered services | Not needed initially |

## 14. Open Questions

1. **Server distribution**: Should we ship self-contained (larger VSIX, no runtime dependency) or framework-dependent (smaller, requires .NET runtime)?
   - Recommendation: Start framework-dependent with `vscode-dotnet-runtime` dependency; move to self-contained for release.

2. **Multi-project support**: The current language server has no multi-file awareness — it compiles each file in isolation. This is tracked as a prerequisite in [#281](https://github.com/DavidObando/gsharp/issues/281). The server must be refactored to support project-level compilation before the extension can provide a useful multi-file experience.
   - Recommendation: Single server instance, workspace-level project discovery from `.gsproj` files.

3. **Extension marketplace**: Where will the extension be published?
   - Options: VS Code Marketplace, Open VSX Registry, or both.

4. **Server update mechanism**: How do we update the language server binary independently of the extension?
   - Recommendation: Bundle with extension; updates require extension version bump.

5. **Formatter**: Should formatting be handled in the language server or as a separate tool (like `dotnet format`)?
   - Recommendation: In the language server for tight integration, but expose a CLI tool as well.
