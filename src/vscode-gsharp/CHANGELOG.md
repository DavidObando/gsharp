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

### Fixed

- TextMate string grammar now recognizes backslash escape sequences (`\"`, `\\`, `\n`, `\t`, `\0`, `\a`, `\b`, `\f`, `\r`, `\v`, `\xNN`, `\uNNNN`, `\UNNNNNNNN`) so an escaped quote like `"text \""` no longer terminates the string early and bleeds string coloring into the rest of the file; unrecognized escapes are flagged as invalid
