# GSharp Language Server Protocol (LSP) Support

The GSharp Language Server provides rich IDE features for `.gs` files via the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/). It is built on [StreamJsonRpc](https://github.com/microsoft/vs-streamjsonrpc) with a hand-authored System.Text.Json protocol layer and communicates over stdin/stdout (or a named pipe / Unix domain socket).

## Supported Capabilities

| Feature | LSP Method | Description |
|---------|-----------|-------------|
| Diagnostics | `textDocument/diagnostic` | Live syntax, semantic, and binding errors pulled as you type (with `workspace/diagnostic/refresh` for cross-file edits) |
| Hover | `textDocument/hover` | Type signature and symbol kind for the token under the cursor; renders CLR XML documentation (from `*.xml` files alongside referenced assemblies) and G# `///` Markdown doc comments as MarkdownContent |
| Go-to-definition | `textDocument/declaration` | Jump from a symbol usage to its declaration. Cross-project: navigates into sibling G# projects in the workspace (via in-memory syntax-tree lookup) and into C# / G# project references and NuGet packages (via portable PDB navigation when sequence points are available; `refint/`-prefixed paths transparently swap to the runtime DLL alongside its PDB). |
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
- **`CrossAssemblyDefinitionResolver`** — dispatches Go-to-Definition for `Imported*Symbol`s and CLR `MemberInfo`s. Tier 1 walks the matching sibling `.gsproj`'s syntax trees; Tier 2 falls back to portable-PDB lookup via **`PdbSourceLocator`**.
- **`PdbSourceLocator`** — opens portable PDBs (sidecar or embedded) with `System.Reflection.Metadata`, caches `MetadataReader`s per assembly file keyed on last-write time, and maps a method's `MetadataToken` to its first sequence point. Transparently swaps `obj/.../refint/{Name}.dll` paths to the sibling runtime DLL so MSBuild's reference-assembly outputs still navigate to source.

## Diagnostics

Diagnostics use the LSP **pull model** (`textDocument/diagnostic`): the editor requests diagnostics as the user types and on save, and the server runs the full pipeline — syntax parse, global-scope semantic analysis, and the binding pass — on every pull, so binding errors (e.g. unreachable code, missing return values, type mismatches inside function bodies) surface live rather than only on save. Results carry a `resultId`; when nothing relevant changed the server returns an `unchanged` report so the client reuses the prior squiggles. The expensive binding pass runs off the request gate and honors cancellation, so a slow analysis does not block interactive requests (hover, completion). For multi-file projects, edits that can affect other open documents trigger a debounced `workspace/diagnostic/refresh` so the client re-pulls them. Clients that do not advertise pull-diagnostic support fall back to push (`textDocument/publishDiagnostics`) on open/change/save. The diagnostic `code` field currently reports the pipeline stage (`Syntax`, `Semantic`, `Binding`). Stable `GS####` diagnostic IDs are planned for a future milestone.

## Interpolation holes are real code (ADR-0055)

Inside an interpreted string, the expression in each `${ … }` hole (and the identifier in `$ident`) is parsed as a real sub-tree whose tokens carry **absolute outer-file spans** (the parser remaps each hole using the lexer's recorded hole offset). As a result, all position-based IDE features work *inside* a hole exactly as they do in ordinary code:

- **Semantic tokens** — `SemanticTokensComputer` no longer classifies an interpolated literal as one opaque `String`. It emits `String` only for the literal text and the `$`/`${`/`}` delimiters *outside* the holes, and overlays each hole expression's identifiers/keywords/numbers classified as real code (variables, functions, types, etc.). Other in-hole code — operators, punctuation, and member names the model cannot resolve — is intentionally left **unclassified** so the TextMate grammar colors it as code rather than as part of the surrounding string. Multi-line holes are split on line boundaries so each line's run is a separate token.
- **Hover, go-to-definition, find-references, rename, completion, signature help** — all resolve a symbol referenced or called inside a hole, and references/rename span both the declaration and its in-hole usages.

A nested interpolated string inside a hole is classified as a single `String` token (its own holes are not recursively decomposed), which keeps emitted semantic-token ranges non-overlapping.

## Limitations

- **Single-file scope** — cross-file navigation and completion are not yet supported; the server analyzes one document at a time.
- **No incremental re-binding** — each pull triggers a full re-parse and re-bind of the active document.
- **Completion is keyword/scope-aware** but does not yet offer member completions on struct instances (dot-triggered completion is registered but scoped to globals).

