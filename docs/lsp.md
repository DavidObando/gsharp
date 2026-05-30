# GSharp Language Server Protocol (LSP) Support

The GSharp Language Server provides rich IDE features for `.gs` files via the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/). It is built on [StreamJsonRpc](https://github.com/microsoft/vs-streamjsonrpc) with a hand-authored System.Text.Json protocol layer and communicates over stdin/stdout (or a named pipe / Unix domain socket).

## Supported Capabilities

| Feature | LSP Method | Description |
|---------|-----------|-------------|
| Diagnostics | `textDocument/publishDiagnostics` | Syntax, semantic, and binding errors streamed on open/change/save |
| Hover | `textDocument/hover` | Type signature and symbol kind for the token under the cursor |
| Go-to-definition | `textDocument/declaration` | Jump from a symbol usage to its declaration |
| Find references | `textDocument/references` | Find all usages of a symbol within the document |
| Document symbols | `textDocument/documentSymbol` | Outline view: functions, variables, structs, enums with children |
| Document highlights | `textDocument/documentHighlight` | Highlight all occurrences of the symbol under cursor |
| Signature help | `textDocument/signatureHelp` | Parameter info at function call sites (triggered on `(` and `,`) |
| Completion | `textDocument/completion` | Scope-aware identifier completion (keywords, globals, locals, types) |
| Rename | `textDocument/rename` | Rename a user-defined symbol across the document |
| Code actions | `textDocument/codeAction` | Refactoring actions (e.g., sort imports) |
| Folding | `textDocument/foldingRange` | Code folding for function bodies |

## Attaching VS Code

1. **Build the language server:**
   ```bash
   dotnet build src/LanguageServer
   ```

2. **Install the extension:**
   Open the `src/LSP-client` folder in VS Code and press `F5` to launch the Extension Development Host. The extension activates for `.gs` files and spawns the language server automatically.

   Alternatively, package and install the extension:
   ```bash
   cd src/LSP-client
   npm install
   npx vsce package
   code --install-extension gsharp-*.vsix
   ```

3. **Open a `.gs` file** (e.g., `samples/HelloWorld/HelloWorld.gs`) and observe:
   - Red squiggles for errors (diagnostics)
   - Hover tooltips showing inferred types
   - Ctrl+Click / F12 to go to definition
   - Shift+F12 to find all references
   - Ctrl+Space for completions
   - Ctrl+Shift+O for document outline
   - F2 to rename a symbol
   - Signature help popup when typing function arguments

## Architecture

```
VS Code ↔ LSP-client (TypeScript extension) ↔ stdin/stdout ↔ GSharp.LanguageServer (C#)
                                                                      ↓
                                                               GSharp.Core
                                                         (Parser → Binder → Compilation)
```

The server creates a `Compilation` per document edit and builds a `SemanticModel` that maps syntax tokens to their resolved symbols. All LSP feature computers are pure functions that take a `DocumentContent` (holding the `SyntaxTree`) and a cursor `Position`, then return the appropriate LSP response.

### Command-line options

The server reads/writes LSP messages over stdin/stdout by default. The following arguments are recognized:

| Argument | Description |
|----------|-------------|
| `--pipe=<name>` | Communicate over a named pipe (Windows) or Unix domain socket instead of stdio. |
| `--log` | Enable protocol logging to a default temporary file (`gsharp-lsp-debug.log` under the system temp directory). |
| `--log=<path>` | Enable protocol logging to a specific file. |

Logging is **opt-in**: when `--log` is not supplied, no log file is created. From the VS Code extension, logging is controlled by the `gsharp.server.log` and `gsharp.server.logPath` settings.

### Key internal types

- **`DocumentContentService`** — thread-safe in-memory store mapping document URIs to their latest `DocumentContent`.
- **`SemanticLookup`** — builds a `SemanticModel` from a `Compilation`, resolves identifier tokens to symbols, finds references, and converts between offsets/ranges.
- **`HoverComputer`**, **`DefinitionComputer`**, **`DocumentSymbolComputer`**, etc. — stateless computers, one per LSP feature.

## Diagnostics

Diagnostics are published on every document open/change (syntax + global-scope errors) and additionally on save (full binding pass). The diagnostic `code` field currently reports the pipeline stage (`Syntax`, `Semantic`, `Binding`). Stable `GS####` diagnostic IDs are planned for a future milestone.

## Limitations

- **Single-file scope** — cross-file navigation and completion are not yet supported; the server analyzes one document at a time.
- **No incremental re-binding** — each edit triggers a full re-parse and re-bind of the active document.
- **Completion is keyword/scope-aware** but does not yet offer member completions on struct instances (dot-triggered completion is registered but scoped to globals).
