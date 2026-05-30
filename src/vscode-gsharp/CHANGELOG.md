# Changelog

All notable changes to the GSharp VS Code extension will be documented in this file.

## [0.1.0] - Unreleased

### Added

- Language registration for `.gs` files
- TextMate grammar for syntax highlighting (keywords, types, operators, literals, comments, strings)
- Language configuration (brackets, comments, indentation, folding)
- LSP client connecting to the GSharp Language Server (stdio transport)
- Hover, completion, go-to-definition, references, rename
- Document symbols, document highlight, folding ranges
- Code actions (quick fixes)
- Signature help
- Push diagnostics (errors/warnings as you type)
- Document formatting, range formatting, on-type formatting
- Semantic tokens (full semantic highlighting)
- Inlay hints (parameter names, inferred types)
- CodeLens (reference counts)
- Workspace symbol search
- Code snippets (fn, if, ife, for, while, class, struct, enum, match, async, try, main)
- Debug configuration provider (gsharp → coreclr)
- Auto-generate launch.json and tasks.json
- Test explorer integration
- Build/run commands with task integration
- Build diagnostics from dotnet build output
- GSharp Dark and GSharp Light color themes
- Server crash recovery with exponential backoff
- Language status bar item (Starting → Ready → Error)
- Project context status bar item
