# Changelog

All notable changes to the GSharp VS Code extension will be documented in this file.

## [0.1.0] - Unreleased

### Added

- Language registration for `.gs` files
- `.gsproj` project files recognized and colorized as XML (like `.csproj`)
- TextMate grammar for syntax highlighting: keywords (including contextual modifiers `data`, `inline`, `record`, `scoped`, accessor names `get`/`set`/`add`/`remove`/`raise`, and ref-kinds `ref`/`out`), declaration keywords (`event`, `prop`, `init`, `delegate`), operators (`:=`, `?.`, `??`, `?`/`:`, `!!`, `...`, `=>`), `@Annotation` scope, and `///` documentation-comment scope with `@tag` highlighting
- Interpolation-hole sub-grammar that styles the alignment integer and `:format` clause inside `${expr,N:fmt}`
- Language configuration (brackets, comments including `///`, indentation, folding)
- LSP client connecting to the GSharp Language Server (stdio transport)
- Hover (incl. CLR XML-doc rendering, chained-member hover, `this` hover), completion, go-to-definition, references, rename
- Document symbols, document highlight, folding ranges
- Code actions (quick fixes)
- Signature help
- Pull-based diagnostics (live errors/warnings, including `///` doc-comment diagnostics GS0227–GS0231)
- Document formatting, range formatting, on-type formatting
- Semantic tokens (full semantic highlighting)
- Inlay hints (parameter names, inferred types)
- CodeLens (reference counts, including on members of structs, interfaces, and enums; 0-refs and stale-tree fixes)
- Workspace symbol search
- Code snippets covering the current grammar: `pkg`, `fn`, `afn`, `extfn`, `lambda`, `main`, `if`, `ife`, `for`, `forin`, `while`, `class`, `classp`, `struct`, `datastruct`, `inlinestruct`, `record`, `enum`, `interface`, `delegate`, `prop`, `autoprop`, `event`, `shared`, `match`, `matchexpr`, `ternary`, `try`, `defer`, `go`, `scope`, `select`, `chan`, `using`, `refparam`, `outparam`, `letref`, `doc`, `ann`
- Debug configuration provider (gsharp → coreclr)
- Auto-generate launch.json and tasks.json
- Test explorer integration
- Build/run commands with task integration
- Build diagnostics from dotnet build output
- Six color themes inspired by the G# logo: Ember, Magma, and Synthwave (Dark + Light each)
- `gsharp.reportIssue` command and Language Server output channel
- Server crash recovery with exponential backoff
- Language status bar item (Starting → Ready → Error)
- Project context status bar item

### Changed

- Language surface (issue #881): a bodyless `func` declaration now requires a terminating `;` — the universal no-body marker for funcs. This affects interface abstract methods (`func Area() float64;`) and interface `shared { }` abstract static slots (`func Add(a int32, b int32) int32;`), making them consistent with P/Invoke (`@DllImport func getpid() int32;`). A `func` that carries a `{ … }` body still takes no `;`. The TextMate grammar already tokenizes `;` as punctuation, so highlighting is unchanged; the `interface` snippet is unaffected.
- TextMate grammar: `static` is no longer highlighted as a contextual keyword. Per issue #865 (ADR-0089 revision) `static` is no longer special on interface members — static-virtual members are declared inside a `shared { … }` block — so `static` reverts to a plain identifier. `shared` continues to highlight in all contexts, including interfaces.

### Fixed

- TextMate string grammar now recognizes backslash escape sequences (`\"`, `\\`, `\n`, `\t`, `\0`, `\a`, `\b`, `\f`, `\r`, `\v`, `\xNN`, `\uNNNN`, `\UNNNNNNNN`) so an escaped quote like `"text \""` no longer terminates the string early and bleeds string coloring into the rest of the file; unrecognized escapes are flagged as invalid
- Language server activation now degrades gracefully when a compatible .NET runtime is missing (#871): the extension verifies a `Microsoft.NETCore.App` runtime matching the server's target major version is available before launching, and when it is absent it shows a single actionable error (with "Install .NET" / "Show Output" actions) instead of a stream of crash toasts and an endless restart loop. The extension also owns the restart policy and suppresses the underlying LanguageClient's default crash notifications.

