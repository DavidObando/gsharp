---
title: "Language Server (LSP)"
sidebar_position: 4
draft: false
---

# Language Server (LSP)

The G# Language Server is a .NET process that speaks the Language Server Protocol over JSON-RPC. Editors normally start it over stdin/stdout; it can also connect to a named pipe or Unix domain socket for clients that manage transport separately.

## Starting the server

Build the server from the repository when developing it locally:

```bash
dotnet build src/LanguageServer
```

By default, the server reads LSP messages from standard input and writes responses and notifications to standard output.

```bash
dotnet src/LanguageServer/bin/Debug/net10.0/GSharp.LanguageServer.dll
```

Recognized command-line arguments are:

| Argument | Behavior |
| --- | --- |
| `--pipe=<name>` | Connect to a Windows named pipe or Unix domain socket instead of stdio. |
| `--log` | Enable protocol logging to the server's default debug log path. In current Unix source that default is `/tmp/gsharp-lsp-debug.log`. |
| `--log=<path>` | Enable protocol logging to a specific file. |

VS Code exposes logging through `gsharp.server.log` and `gsharp.server.logPath`.

## Advertised capabilities

Current source advertises more than the older `docs/lsp.md` table. The server capability factory currently enables:

| Capability | LSP surface |
| --- | --- |
| Text synchronization | Open/close, full-document changes, save with text. |
| Diagnostics | `textDocument/publishDiagnostics` notifications after open/change/save. |
| Hover | `textDocument/hover`. |
| Definition | `textDocument/definition`. |
| Type definition | `textDocument/typeDefinition`. |
| Implementation | `textDocument/implementation`. |
| References | `textDocument/references`. |
| Document highlights | `textDocument/documentHighlight`. |
| Document symbols | `textDocument/documentSymbol`. |
| Workspace symbols | `workspace/symbol`. |
| Formatting | `textDocument/formatting`, `textDocument/rangeFormatting`, and `textDocument/onTypeFormatting`. |
| Folding ranges | `textDocument/foldingRange`. |
| Selection ranges | `textDocument/selectionRange`. |
| Linked editing | `textDocument/linkedEditingRange`. |
| Completion | `textDocument/completion`, triggered on `.`. |
| Signature help | `textDocument/signatureHelp`, triggered by `(` and `,`. |
| Rename | `textDocument/prepareRename` and `textDocument/rename`. |
| Code actions | `textDocument/codeAction`, currently refactor/rewrite-style actions. |
| Code lenses | `textDocument/codeLens`, currently reference-count lenses for declarations. |
| Semantic tokens | Full and range semantic tokens. |
| Inlay hints | `textDocument/inlayHint`, currently parameter-name hints at call sites. |

## Diagnostics lifecycle

On open and change, the server parses the active document and publishes responsive syntax/global-scope diagnostics while skipping the full binding pass. On save, it runs the fuller binding pipeline and republishes diagnostics. The active document is stored in memory, and if it belongs to a discovered `.gsproj`, the project state is updated before diagnostics are computed.

## Workspace and project awareness

During `initialize`, the server attempts best-effort workspace discovery from the root path or root URI. It tracks `.gsproj` and `.gs` file changes, registers source files with projects, and can fall back to an implicit project for single-file editing. Symbol operations use the active document or the current project compilation when available.

## Feature notes and limitations

- Completion is scope-aware and dot-triggered, but the implementation remains much simpler than mature .NET language services.
- Formatting is a lexer-based whole-document formatter with a canonical whitespace pass; current implementation uses two-space indentation internally.
- Rename, linked editing, references, CodeLens, implementation, and type-definition results are computed from the compiler's semantic lookup model and are strongest for symbols in the current project/document model.
- The server serializes handlers through a single gate so edits and reads are processed in order, not incrementally in parallel.

## Connecting an editor

An editor client needs to launch the server, speak standard LSP framing, and register `.gs` documents as the `gsharp` language. VS Code does this through the bundled extension. Other editors can use stdio with the default server command or `--pipe=<name>` if the editor prefers a socket/pipe transport.
