# G# for Visual Studio Code

Rich language support for the [G# programming language](https://github.com/DavidObando/gsharp) in Visual Studio Code.

## Features

- **Syntax Highlighting** — Full TextMate grammar for `.gs` files
- **IntelliSense** — Completions, hover info, signature help
- **Navigation** — Go to definition, find references, document symbols, workspace symbols
- **Refactoring** — Rename, code actions (quick fixes)
- **Diagnostics** — Real-time errors and warnings as you type
- **Formatting** — Document formatting, range formatting, and on-type formatting
- **Semantic Highlighting** — Rich semantic token types for precise colorization
- **Inlay Hints** — Parameter names and inferred types
- **CodeLens** — Reference counts above functions and types
- **Debugging** — Launch and debug GSharp applications (via CoreCLR debugger)
- **Test Explorer** — Discover, run, and debug tests
- **Build Integration** — Build, run, and clean commands with error reporting
- **Snippets** — Common code patterns (functions, classes, loops, etc.)
- **Themes** — Six color themes inspired by the G# logo's amber-to-red palette: Ember, Magma, and Synthwave, each in Dark and Light variants

## Requirements

- [.NET 10 Runtime](https://dotnet.microsoft.com/download/dotnet/10.0) or newer (the language server targets `net10.0`). When a compatible runtime is not already on the machine, the extension automatically downloads one via the [.NET Install Tool](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.vscode-dotnet-runtime) (installed as a dependency). If automatic acquisition is not possible (for example, the machine is offline with nothing cached), the extension shows a single actionable prompt instead of failing silently.
- [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) (for debugging support)

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gsharp.server.path` | `""` | Path to the GSharp Language Server executable |
| `gsharp.server.waitForDebugger` | `false` | Wait for a debugger to attach to the language server |
| `gsharp.trace.server` | `"off"` | Trace LSP communication (`off`, `messages`, `verbose`) |
| `gsharp.diagnostics.enableOnType` | `true` | Run diagnostics on every keystroke |
| `gsharp.completion.triggerOnDot` | `true` | Trigger completion after typing `.` |
| `gsharp.codeLens.enableReferences` | `true` | Show reference counts |
| `gsharp.inlayHints.enableParameterNames` | `true` | Show parameter name hints |
| `gsharp.inlayHints.enableTypeHints` | `true` | Show inferred type hints |
| `gsharp.coldStartCache.enable` | `true` | Persist language-service project metadata |

Language feature settings take effect after running **GSharp: Restart Language Server**.
Formatting is canonical and option-free: 4 spaces, K&R braces, and a fixed
120-column width. Format-on-save is enabled for G# by default.

### Syntax highlighting and semantic tokens

Visual Studio packages the VS Code TextMate grammar directly; it has no separate
grammar to synchronize. The website registers its G# Prism grammar in
`website/src/theme/prism-include-languages.ts`. Both engines run the shared
`src/test/grammar-cases.json` lexical regression cases.
Interpolation cases cover byte literals, nullable array elements, nested dollar
escapes, and literal `$${...}` openers. Optional `absent` spans reject incorrect scopes;
`format` suffixes also reject format scopes anywhere in the expression.
Persistent type-head/tail states protect nested generic nullable suffixes across
physical lines. Member contexts consume exactly one name, including after trivia.
Pattern primaries distinguish discard, constant, and `var` bindings from types;
`not`/`and`/`or` introduce the appropriate next primary rather than a nullable name.
List patterns do not consume an element-type name; parenthesized patterns retain
their conditional arms while nullable tuple types retain their suffix.
Adjacent `?(` invokes any postfix receiver, including indexed and call results;
whitespace-separated `? (` remains conditional. Nested index expressions retain
their own conditional delimiters. Named tuple array elements remain types, while
property suffixes and relational operands preserve following pattern combinators.
Completed literals and `!!` keep postfix context; unary `!` does not. Function
parameter modifiers are distinct from tuple element names and ordinary types
named `ref`/`out`/`in`. Constant-pattern operands use expression context, including
signs and exponents. Value-receiver pointer arrows preserve member context;
lambda heads and function-type return arrows retain their own contexts.
Anonymous-class header colons stay in expressions. Line comments accept CR, LF,
and CRLF line endings.

Lexical highlighting recognizes reserved/contextual words, escaped and Unicode
identifiers, literal forms, interpolation, annotations, and operators. Contextual
words can still be ordinary names. Declaration/call scopes and Prism's PascalCase
type convention are lexical hints, not symbol resolution. Neither grammar can
determine overloads, shadowing, extension ownership, imported nullability, or
whether a name denotes a type, property, or local in every context. The language
server's semantic tokens supply symbol-aware editor classifications; Prism has
no language server. Imported platform types (`T!`) are display notation, not new
source syntax.

Run the shared cases with `npm run test:unit -- --runInBand grammar.test.ts` here
and `node --test --test-name-pattern=Prism tests/content.test.mjs` in `website`.
The editor tests use the real TextMate/Oniguruma tokenizer, not JavaScript regex
approximations.
Before asserting an ambiguous interpolation's scopes, check its expression kind
and `InterpolatedStringSegment.Format` with the compiler's `SyntaxTree.Parse`;
two agreeing highlighters do not establish the language's parse.
The compiler currently loses enclosing unsafe context for bare-name pointer
arrows inside interpolation (#5110); pointer regressions use compiler-accepted
call, index and qualified receivers instead of asserting an invented parse.

## Commands

| Command | Description |
| --- | --- |
| `GSharp: Restart Language Server` | Restart the language server |
| `GSharp: Show Output Channel` | Show the GSharp output channel |
| `GSharp: Build Project` | Build the GSharp project |
| `GSharp: Run Project` | Run the GSharp project |
| `GSharp: Generate Build & Debug Assets` | Generate `.vscode/tasks.json` and `launch.json` |
| `GSharp: Run Tests at Cursor` | Run tests at the current cursor position |
| `GSharp: Debug Tests at Cursor` | Debug tests at the current cursor position |
| `GSharp: Report Issue` | Open GitHub Issues for bug reports |

## License

MIT
