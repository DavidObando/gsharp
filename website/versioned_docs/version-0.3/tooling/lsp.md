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
dotnet out/bin/Debug/LanguageServer/GSharp.LanguageServer.dll
```

Recognized command-line arguments are:

| Argument | Behavior |
| --- | --- |
| `--pipe=<name>` | Connect to a Windows named pipe or Unix domain socket instead of stdio. |
| `--log` | Enable protocol logging to the server's default debug log path. In current Unix source that default is `/tmp/gsharp-lsp-debug.log`. |
| `--log=<path>` | Enable protocol logging to a specific file. |

VS Code exposes logging through `gsharp.server.log` and `gsharp.server.logPath`.

## Advertised capabilities

The server capability factory enables the following:

| Capability | LSP surface |
| --- | --- |
| Text synchronization | Open/close, full-document changes, save with text. |
| Diagnostics | `textDocument/diagnostic` pull requests (live as-you-type), with `workspace/diagnostic/refresh` for cross-file edits; falls back to `textDocument/publishDiagnostics` for push-only clients. |
| Hover | `textDocument/hover`. |
| Definition | `textDocument/definition`. |
| Type definition | `textDocument/typeDefinition`. |
| Implementation | `textDocument/implementation`. |
| References | `textDocument/references`. |
| Document highlights | `textDocument/documentHighlight`. |
| Document symbols | `textDocument/documentSymbol`. |
| Workspace symbols | `workspace/symbol`. |
| Formatting | `textDocument/formatting` (whole-document only). Range and on-type formatting were intentionally dropped; the server no longer advertises those capabilities and handles the corresponding requests as safe no-ops. |
| Folding ranges | `textDocument/foldingRange`. |
| Selection ranges | `textDocument/selectionRange`. |
| Linked editing | `textDocument/linkedEditingRange`. |
| Completion | `textDocument/completion`. The server advertises `.` as its only trigger character, while the VS Code extension enables quick suggestions for `[gsharp]`, so completions appear as you type identifiers, keywords, and member names. Mid-identifier completions include replacement ranges so accepting an item replaces the typed prefix. In type-clause positions the list includes ready-to-use snippets for `async (T) -> R` and `async sequence[T]`. |
| Signature help | `textDocument/signatureHelp`, triggered by `(` and `,`. |
| Rename | `textDocument/prepareRename` and `textDocument/rename`. |
| Code actions | `textDocument/codeAction`, exposing project-wide refactorings (e.g. `Sort imports`) and quick fixes for the nil-related diagnostics covered in [Quick fixes](#quick-fixes-textdocumentcodeaction) below. |
| Code lenses | `textDocument/codeLens`, currently reference-count lenses for declarations. |
| Semantic tokens | Full and range semantic tokens. |
| Inlay hints | `textDocument/inlayHint`, currently parameter-name hints at call sites. |

## Diagnostics lifecycle

The server keeps the active document parsed in memory and, when it belongs to a discovered `.gsproj`, updates the project state on open/change/save. Diagnostics are served through the LSP **pull model**: the editor requests `textDocument/diagnostic` as the user types and on save, and the server runs the full pipeline — syntax, global-scope semantic analysis, and the binding pass — on every pull, so binding errors appear live rather than only on save. Each report carries a `resultId`; unchanged results return an `unchanged` report so the client reuses existing squiggles. The binding pass runs off the handler gate and supports cancellation, keeping interactive requests responsive, and cross-file edits in multi-file projects trigger a debounced `workspace/diagnostic/refresh`. Push-only clients (no pull-diagnostic capability) fall back to `textDocument/publishDiagnostics` on open/change/save.

## Workspace and project awareness

During `initialize`, the server attempts best-effort workspace discovery from the root path or root URI. It tracks `.gsproj`, `.gs`, and `.resx` file changes, registers source files with projects, and can fall back to an implicit project for single-file editing. When a `.resx` is created or changed inside a project, the server regenerates the adjacent `Resources.Designer.gs`-style codebehind through the shared resx generator; deleting a `.resx` leaves any existing designer file in place, matching Visual Studio behavior. Symbol operations use the active document or the current project compilation when available.

## Performance and generated project state

The 0.3 language server has several incremental paths that keep editor features responsive on larger projects:

- **Incremental delta binding:** body-only edits reuse unchanged per-file declarations and bound bodies instead of rebinding the whole project.
- **Incremental semantic model:** syntax-node buckets are memoized per `SyntaxTree`, and function-local maps per reused bound body, so hover, definition, and completion rebuild only the changed inputs when possible.
- **Cross-session cold-start cache:** each project can write a generated `<AssemblyName>.gsproj.lscache` next to the project. It records the project reference snapshot and reference-metadata index, is safe to delete, is gitignored by default, and can let references resolve after a clean or fresh clone without a prior build when the recorded reference DLLs still validate.
- **Unified member resolution:** binder and LSP member lookup share `TypeMemberModel`, reducing hover/completion versus build mismatches for user type members.

The VS Code setting `gsharp.coldStartCache.enable` controls the cold-start cache. When it is left unset, the extension also honors the C# Dev Kit `dotnet.projectsystem.enableLanguageServiceCache` setting as a fallback.

## Feature notes and limitations

- Completion is scope-aware. Dot member completion still uses the server trigger character, and VS Code quick suggestions invoke the same completion provider as you type ordinary code. Type-clause positions additionally surface `async (T) -> R` and `async sequence[T]` snippets so the async-type spellings are discoverable without having to know they exist.
- Formatting is a lexer-based whole-document formatter with a canonical whitespace pass; current implementation uses two-space indentation internally.
- Rename, linked editing, references, CodeLens, implementation, and type-definition results are computed from the compiler's semantic lookup model and are strongest for symbols in the current project/document model.
- The server serializes handlers through a single gate so edits and reads are processed in order. Incremental binding/model caches reduce repeated work; handlers are not processed in parallel.

## Quick fixes (textDocument/codeAction)

The server returns a mix of whole-document refactorings and diagnostic-driven quick fixes from `textDocument/codeAction`. Refactorings (such as `Sort imports`) surface whenever they apply; quick fixes only surface when the request range overlaps the originating diagnostic's span.

The current quick-fix set targets nil-related diagnostics. Each diagnostic maps to one or more rewrites, returned as LSP `TextEdit`s so they compose with concurrent client edits without server-side re-parsing:

| Diagnostic | Trigger | Offered rewrites |
| --- | --- | --- |
| `GS0158` (`Cannot find member X.`) | A `.` member access whose left-part is statically nullable (chained `?.`, literal `nil`, or a local/parameter/field whose declared type-clause text ends with `?`). | `Use null-conditional access '?.'` — rewrites the dot token to `?.`. |
| `GS0154` (`Parameter 'p' requires a value of type 'T' but was given a value of type 'T?'.`) | Any argument of type `T?` passed to a parameter typed `T`. | `Provide default with '?? <literal>'` and `Assert non-nil with '!!'`. |
| `GS0155` (`Cannot convert type 'T?' to 'T'.`) | Any expression of type `T?` used where `T` is required (assignment, return, conditional arm, …). | Same as GS0154. |
| `GS0156` (`Cannot convert type 'T?' to 'T'. An explicit conversion exists ...`) | Same shape as GS0155 with an explicit conversion available. | Same as GS0154. |
| `GS0274` (`'nil' cannot be assigned to parameter 'p' of non-nullable type 'T'; …`) | Literal `nil` flowing to a non-nullable parameter. | No quick fix — the diagnostic message already carries the canonical suggestion (make the parameter nullable). |

The null-coalescing rewrite picks a sensible default literal per primitive target type (`""` for `string`, `0` for the numeric primitives, `false` for `bool`, `default` otherwise) so the inserted snippet parses and type-checks immediately; the user is expected to replace it with a real default. Both the null-coalescing and the null-assertion rewrite wrap the original expression in parentheses, so the replacement is syntactically self-contained regardless of the surrounding operator precedence.

## Connecting an editor

An editor client needs to launch the server, speak standard LSP framing, and register `.gs` documents as the `gsharp` language. VS Code does this through the bundled extension. Other editors can use stdio with the default server command or `--pipe=<name>` if the editor prefers a socket/pipe transport.
