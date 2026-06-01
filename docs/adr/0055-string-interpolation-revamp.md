# ADR-0055: String interpolation revamp — rich, reliable, tool-aware

- **Status**: Proposed
- **Date**: 2026-06-01
- **Phase**: Phase 3 (language hardening); reliability sub-task is Phase 2 hotfix-eligible
- **Related**: ADR-0007 (Kotlin-style choice — amended, not reversed), ADR-0011 (grammar + lowering — **superseded on acceptance**), ADR-0012 (raw strings stay non-interpolating), ADR-0044 (numeric primitives), docs/lexical.md §interpolation, docs/diagnostics.md, docs/lsp.md, docs/vscode-gsharp-spec.md, issue #366

## Context

### The triggering failure (#366)

The following program crashes the process, not just the compilation:

```gs
package Temp
import System
let a = (100.0 / 2.0)
Console.WriteLine("a: ${a}")              // prints "a: 50"
Console.WriteLine("a type: ${a.GetType()}") // Fatal AccessViolationException
```

Observed runtime behaviour: `Fatal error. System.AccessViolationException: Attempted to read or write protected memory` originating in `Console.WriteLine(string)`. The same call `a.GetType()` works fine outside an interpolation. The crash is therefore *specific to the interpolation lowering path*, and it is the most damaging class of bug a language can ship: a well-typed source program produces memory-unsafe IL.

### Root cause, established empirically

The binder lowers every interpolated string to a left-associative `+`-chain in which each non-string hole is wrapped in `System.Convert.ToString(...)` (ADR-0011; `Binder.cs` `BindInterpolatedStringExpression`/`ConvertToString`, ~line 5491). Two defects compound:

1. **Type-safety hole.** `Convert.ToString(object)` returns `string?`, but `Concat` force-binds the operator with `BoundBinaryOperator.Bind(PlusToken, String, String)`, asserting a `string` operand. Writing the same expression by hand — `"x " + System.Convert.ToString(a.GetType())` — is correctly *rejected* by the binder: `GS0129: Binary operator '+' is not defined for types 'string' and 'string?'`. The interpolation path silently constructs a bound tree the binder would otherwise refuse. The bound tree's claimed types diverge from the values flowing through it.

2. **Boxing/stack-shape mismatch in the lowered concat.** `${a.GetType()}` lowers to `... + Convert.ToString(a.GetType())`, where `a` is a value type. The value-type-receiver boxing logic (`ReflectionMetadataEmitter.cs` ~10230, `BoundImportedInstanceCallExpression`) is correct *in isolation*, but when that call is nested as the argument of an imported `Convert.ToString` inside a `string + string` concat whose operand types are mis-asserted (defect 1), the emitter produces IL whose evaluation stack does not match the verifier's expectation. The runtime reinterprets bits and faults. The defect is not in any single emit case; it is that **lowering happens in the binder, eagerly, and throws away type/format intent that the emitter needs to emit correct IL**.

### Current capability inventory (all layers)

| Layer | File(s) | State today |
| --- | --- | --- |
| Lexer | `Lexer.cs` `ReadString` (571–706) | Recognizes `$ident`, `${expr}`, `$$`→`$`. Hole scanner is **brace-depth only**, **not** string/char/paren aware, and **terminates a hole at `"`, `\r`, `\n`**. No format/alignment. |
| Parser | `Parser.cs` `ParseInterpolatedStringLiteral` (3881) | Re-parses each hole's text via a **fresh `SyntaxTree.Parse`**; inner diagnostics/positions are **not remapped** to the outer file (anchored to the string token). |
| Bound model | `BoundNodeKind.cs` | **No** `InterpolatedStringExpression` node — lowered immediately to `+`-chain. |
| Binder | `Binder.cs` 5491–5557 | `Convert.ToString` `+`-chain; the defects above. No format/alignment/culture. |
| Interpreter (tree-walk `Compilation.Evaluate`) | shares the binder's `+`-chain | Works for trivial cases; inherits every binder defect. No separate formatting path. |
| Emit | `ReflectionMetadataEmitter.cs` 10185–10311 | Emits the `+`-chain as ordinary `String.Concat`/boxing; source of the crash. |
| LSP | `SemanticTokensHandler.cs` 173 | Whole literal classified as one `String` token. **No** hole classification, **no** hover/goto/completion/signature-help inside `${...}`. |
| VSCode grammar | `src/vscode-gsharp/syntaxes/gsharp.tmLanguage.json` 35–57 | Colors `${...}` braces; **does not recognize `$ident`**; no `:format`/`,alignment`; no recursive expression coloring. |
| Tests/samples | `InterpolatedStringTests.cs`, `samples/InterpolatedString.gs`, ~15 other samples | Cover only `$ident`, `${simple}`, `$$`. |

### What "enterprise-grade" means here

Engineers arriving from C# expect, and production code relies on, four properties this feature lacks: (1) **memory and type safety** — a compiling interpolation never faults and never lies about operand types; (2) **format and alignment control** — `${price:N2}`, `${name,-20}`, culture-aware and culture-explicit formatting; (3) **rich holes** — nested strings, method calls, conditionals, multiline expressions; (4) **first-class tooling** — the IDE treats a hole as real code (coloring, hover, go-to-definition, completion, signature help, precisely-placed diagnostics). C# delivers all four through a single coherent pipeline (Roslyn `Binder_InterpolatedString` → `LocalRewriter_StringInterpolation` → `string.Format` / `DefaultInterpolatedStringHandler` / `FormattableString`). G# delivers none of them.

### Precedents

- **C#**: `$"{expr,align:format}"`, `{{`/`}}` escapes, contextual lowering to `string.Format`, `DefaultInterpolatedStringHandler` (C# 10, low-alloc), `FormattableString`/`IFormattable` (culture-deferred), user `[InterpolatedStringHandler]` types, C# 11 multiline holes. Maximum power; significant compiler surface.
- **Kotlin**: `$name`/`${expr}`, no format specifiers (formatting via `String.format`/extension). Light grammar; ADR-0007's chosen base.
- **Swift**: `\(expr)`; no format mini-language.
- **Rust**: `format!("{x:.2}")` — format spec lives in the literal, args are positional/captured; compile-time-checked format mini-language.

G# already chose Kotlin's *sigil-free literal* (ADR-0007). The gap versus enterprise C# is entirely in the **hole**: its grammar, its lowering, and its tooling. This ADR closes that gap without reversing ADR-0007.

## Decision

Adopt a four-part revamp: **(A)** a richer, delimiter-aware hole grammar; **(B)** a dedicated bound node with *late*, tiered, culture-correct lowering that eliminates the #366 class of bug; **(C)** LSP support that treats holes as real code with remapped spans; **(D)** a TextMate grammar that colors every hole construct. The literal stays sigil-free (`$ident`/`${…}`, ADR-0007); raw backtick strings stay verbatim (ADR-0012).

### A. Grammar

Inside a double-quoted string literal:

```
Interpolation := "$" "$"                                  -- literal '$'
              |  "$" Identifier                            -- $name
              |  "$" "{" Hole "}"                          -- ${ ... }
              |  "$" <any other char>                      -- literal '$' + char (forward-compat, unchanged)

Hole          := Expression [ "," Alignment ] [ ":" FormatString ]
Alignment     := [ "-" ] DecimalDigits                    -- constant; '-' left-justifies (C# parity)
FormatString  := <verbatim chars up to the hole's closing '}', delimiter-aware>
```

Decisions and their rationale:

- **Format and alignment are added to `${…}` only** (never to `$ident`). `${price,10:N2}` is now legal. This is the single largest usability win and the headline of the revamp. `$ident` stays a pure shorthand for `${ident}` with default format.
- **The hole is scanned by a delimiter-aware sub-scanner**, replacing the brace-depth counter. It tracks nesting across `()`, `[]`, `{}`, and skips over nested `"…"` and `'…'` literals and `/* … */`/`//` comments. The **first top-level `:`** (not inside any nested delimiter) begins the format clause; the **first top-level `,`** begins the alignment clause. This makes `${cond ? "a" : "b"}`, `${dict["k"]}`, and **`${a.GetType()}`** parse correctly, and resolves the long-standing ADR-0011 limitation that `${"…"}` broke the scan.
- **Multiline holes are allowed.** A `${…}` may span newlines (C# 11 parity); only an unterminated *literal* (closing `"` missing) is an error. Literal text segments still may not contain raw newlines.
- **Brace escaping is unnecessary.** Because a hole must be introduced by `$`, a bare `{`/`}` in literal text is already literal — no `{{`/`}}` doubling (a strict ergonomic improvement over C#). A literal `${` is written `$${` (the existing `$$`→`$` rule, then literal `{`).
- **Raw strings (backtick) remain non-interpolating** (ADR-0012, unchanged).
- The `Expression` grammar inside a hole is the full G# expression grammar, parsed in the enclosing binder's scope.

### B. Bound model and lowering

**Stop lowering in the binder.** Introduce a first-class bound node `BoundInterpolatedStringExpression` (new `BoundNodeKind.InterpolatedStringExpression`) carrying an ordered list of parts, each either a literal `string` or a `{ BoundExpression value, int? alignment, string? format }` hole. The node's type is `string` (or the contextual target type, see tiers). This preserves format/alignment/culture intent through binding so that **both** the tree-walk interpreter **and** the IL emitter can render it correctly and identically. Lowering moves *late* — into the `Lowerer` / emitter — exactly as async and `for-in` are lowered late today.

Adding the bound node requires the standard coverage-matrix update (`test/Core.Tests/CoverageMatrix/coverage-matrix.golden.txt` and `docs/coverage-matrix.md`), per CoverageMatrixGoldenTests.

**Tiered lowering**, chosen per call site by the binder/Lowerer:

1. **Tier 0 — constant fold.** If every part is a compile-time constant string (no holes, or holes that are constant strings), fold to a single `string` literal.
2. **Tier 1 — `String.Concat` (default for string-only, no format/alignment).** Holes already typed `string` with no format/alignment lower to `String.Concat(string, …)` / `String.Concat(string[])`. Holes that are *non-string with no format/alignment* render via **`String.Concat(object[])`** (the runtime calls each element's virtual `ToString()` — culture-current for `IFormattable` primitives) **or**, when a single hole, via an explicit, type-correct conversion. This replaces the `Convert.ToString(object)` `+`-chain and its `string?`/boxing defects: the operand types in the bound tree now match the values, so the emitter produces verifiable IL. **This tier alone fixes #366.**
3. **Tier 2 — `String.Format(IFormatProvider, string, object[])` (any hole has format or alignment).** The Lowerer synthesizes the composite format string (`"{0}"`, `"{0,10}"`, `"{0,-20:N2}"`) and an `object[]` argument pack. The provider is `CultureInfo.CurrentCulture` by default (C# parity), threaded explicitly so behaviour is never ambient-locale-by-accident at the IL boundary.
4. **Tier 3 — `DefaultInterpolatedStringHandler` (opt-in / when the emitter supports it).** For allocation-sensitive paths, lower to the runtime handler: construct `(literalLength, formattedCount)`, emit `AppendLiteral(string)` / `AppendFormatted<T>(T, int alignment, string format)`, finish with `ToStringAndClear()`. This is the C# 10 model and the long-term target, but it depends on emitter capabilities G# does not yet have (`ref struct` locals, generic `AppendFormatted<T>`, `out bool` short-circuit overloads). **Gated behind Phase 3+; not required for the reliability fix.**
5. **Tier 4 — contextual conversion.** When the interpolation occurs in a context whose target type is `System.IFormattable` or `System.FormattableString`, lower to `FormattableStringFactory.Create(format, args)` instead of eagerly producing a `string`, enabling culture-deferred formatting (`fs.ToString(CultureInfo.InvariantCulture)`). This gives enterprise code explicit, testable culture control.

**Conversion-to-string of a hole value** is, in tiers 1–3, performed by the *runtime* (`object.ToString()`/`IFormattable.ToString(format, provider)` via `String.Format`/`String.Concat(object[])`), never by a compiler-injected `Convert.ToString` whose nullable return is then mis-typed. Null holes render as empty string (C# parity), which `String.Format`/`String.Concat(object[])` already guarantee.

### C. LSP / IDE

- **Span remapping (foundational).** Re-parse each hole with a known absolute offset so every inner token, node, and diagnostic maps to its true location in the outer file. Concretely: thread the hole's source offset (already captured as `InterpolationFragment.Position`) into the inner parse and add it to inner spans (or parse the hole in-place against the original `SourceText`). This single fix unlocks everything below and corrects today's behaviour where hole diagnostics point at the whole string token.
- **Semantic tokens.** Emit distinct classifications: `$`/`${`/`}`/`:`/`,` as `operator`/`string` punctuation, the format string as `string`, and the **hole expression tokenized as real code** (identifiers, keywords, numbers, member access) rather than one opaque `String`. Mirrors C#'s `meta.interpolation` treatment.
- **Hover, go-to-definition, find-references, completion, signature help** work inside `${…}` because the hole is a real, correctly-positioned sub-tree. Typing `${customer.` offers member completion; `${Foo(` shows signature help.
- **Diagnostics** for malformed holes are precise (new codes, continuing `docs/diagnostics.md` from GS0211): e.g. `GS0212 Unterminated interpolation hole`, `GS0213 Empty interpolation hole`, `GS0214 Invalid alignment value (must be a constant integer)`, `GS0215 Empty format specifier`, `GS0216 Newline in literal portion of interpolated string`. Each carries the exact remapped span.

### D. VSCode TextMate grammar

Extend `gsharp.tmLanguage.json` so the interpolated string (`string.quoted.double.gsharp`) contains a `patterns` list recognizing:

- `meta.interpolation.gsharp` for `${ … }` with `punctuation.definition.interpolation.begin/end`, recursively including the gsharp expression patterns for the hole body, and a `punctuation.separator.interpolation` `:`/`,` plus `meta.interpolation.format` for the format string.
- A new rule for **`$ident`** (`variable.interpolation.gsharp`) — currently unrecognized.
- `constant.character.escape.gsharp` for `$$`.
- **No** interpolation patterns inside the raw backtick grammar (ADR-0012).

This matches the scope names C# themes already style, so existing color themes light up holes with zero theme changes. Mirror the change in `docs/vscode-gsharp-spec.md`.

## Cost of each design point

| Design point | Benefit | Cost / risk |
| --- | --- | --- |
| Dedicated `BoundInterpolatedStringExpression` + late lowering | Fixes #366 class permanently; one source of truth for interpreter + emit; enables format/culture | New bound node; coverage-matrix golden update; touch Lowerer, Evaluator, emitter, BoundTreeRewriter/Walker |
| Tier 1/2 lowering (`Concat`/`Format`, explicit provider) | Memory-safe, type-correct, culture-explicit; **ships the bug fix alone** | Moderate: build composite format string + `object[]`; choose tier per site |
| Format/alignment grammar `${e,a:f}` | Headline C#-parity usability | Delimiter-aware sub-scanner (replaces brace counter); 4–5 new diagnostics; lexer + parser changes |
| Delimiter-aware hole scanner | Nested strings/calls/ternary/indexers parse; removes ADR-0011 `${"…"}` limitation | Real sub-scanner: track `()[]{}`, skip nested string/char/comment; most intricate single change |
| Multiline holes | C# 11 parity; readable complex holes | Lexer must not terminate holes on newline; revise unterminated-string detection |
| Span remapping in parser | Correct diagnostics + unlocks all IDE features in holes | Thread offset through inner parse or parse in place; audit every inner span |
| LSP semantic tokens for holes | Holes colored/navigable as code | New classifier path; depends on remapping |
| LSP hover/goto/completion/signature in holes | Enterprise IDE parity | Mostly free once remapping lands; per-feature wiring/tests |
| TextMate grammar extension | Correct coloring incl. `$ident`, `:format` | Low; recursive include + raw-string exclusion test |
| Tier 3 `DefaultInterpolatedStringHandler` | Low-alloc hot-path formatting | High: needs `ref struct`, generic `AppendFormatted<T>`, `out bool` overloads — emitter work G# lacks; defer |
| Tier 4 `IFormattable`/`FormattableString` | Culture-deferred, testable formatting | Medium: contextual target-type detection; `FormattableStringFactory` binding |

## Phased rollout

- **Phase 2 (reliability hotfix, ship first):** Introduce `BoundInterpolatedStringExpression`; implement Tier 0/1 lowering with correct operand types and explicit-provider `String.Format` where needed; route the interpreter through the new node. **Closes #366.** No grammar change yet. Add a `samples/InterpolatedStringTypeReflection.gs` + `.golden` regression covering `${a.GetType()}` and value-type holes.
- **Phase 3 (usability):** Delimiter-aware scanner; `${e,align:format}`; multiline holes; Tier 2 generalized; new diagnostics GS0212–GS0216; parser span remapping. Update `docs/lexical.md`, `docs/diagnostics.md`.
- **Phase 3 (tooling, parallelizable with usability):** LSP semantic tokens + hover/goto/completion/signature in holes; TextMate grammar; `docs/lsp.md`, `docs/vscode-gsharp-spec.md`.
- **Phase 3+ (performance/extensibility, optional):** Tier 3 handler lowering; Tier 4 `FormattableString`; user `[InterpolatedStringHandler]` support — each contingent on emitter `ref struct`/generic-append support. Tracked blockers: #367 (`ref struct` support), #368 (`[InterpolatedStringHandler]` pattern), #369 (`IFormattable`/`FormattableString` conversion).

## Consequences

Positive:

- A compiling interpolation can no longer fault the process or misrepresent operand types — the most important reliability property, fixed at the root (late lowering + matched types).
- C#-parity expressiveness (`,alignment`, `:format`, nested strings, ternaries, indexers, multiline) with *less* escaping ceremony (no `{{`/`}}`).
- Explicit culture handling (`CurrentCulture` default; `Invariant`/provider via `FormattableString`) — auditable, testable, no accidental ambient-locale formatting.
- Holes become real code in the IDE: coloring, hover, navigation, completion, signature help, and precisely-located diagnostics.
- One bound representation shared by interpreter and emitter eliminates interpret/compile drift for this feature.

Negative:

- Net-new compiler surface (sub-scanner, bound node, tiered Lowerer, remapping) and the coverage-matrix/golden churn that accompanies a new node and new `SyntaxKind`s.
- The delimiter-aware scanner is the trickiest single change; mis-scanning a hole is a parse-quality regression risk and needs a dense fuzz/property test suite.
- Tier 3/4 depend on emitter features G# does not have, so full C# performance/extensibility parity is deferred, not delivered, by this ADR.

Neutral:

- `$ident` is unchanged and remains the common-case shorthand; existing programs and samples keep working (format/alignment are purely additive to `${…}`).
- Supersedes ADR-0011's grammar and lowering; preserves ADR-0007's literal-syntax choice and ADR-0012's raw-string verbatim rule.

## Alternatives considered

- **Point-fix the emitter for #366 only.** Patch the specific boxing/stack case and keep the `Convert.ToString` `+`-chain. Rejected: it treats a symptom of an architectural defect (eager binder lowering that discards type intent and asserts `string` over `string?`). The next nested-hole shape would reopen the same class of crash, and it delivers none of the usability/tooling the issue ultimately motivates.
- **Switch the literal to C# `$"…"` sigil with `{expr}` holes and `{{`/`}}` escapes.** Rejected: reverses ADR-0007 for no semantic gain, breaks every existing sample, and *adds* escaping ceremony. The hole grammar — not the literal sigil — is where the value is.
- **Lower everything to `DefaultInterpolatedStringHandler` immediately (full C# model).** Rejected for now: the emitter lacks `ref struct` locals, generic `AppendFormatted<T>`, and `out bool` short-circuit support; building those is a multi-ADR effort that must not gate the safety fix. Kept as Tier 3 target.
- **Keep lowering in the binder but fix the types.** Rejected: even with correct types, binder-time lowering discards format/alignment/culture intent the interpreter and emitter need, and forces the interpreter to re-derive formatting from a `+`-chain. The dedicated bound node is the smaller long-run cost.
- **Format mini-language checked at compile time (Rust `format!` style).** Rejected for this ADR: G# defers format-string interpretation to the runtime (`IFormattable`/`String.Format`), matching .NET semantics and custom format providers; a compile-time-checked grammar is a possible additive future ADR, not a prerequisite.
- **No format specifiers (stay Kotlin-pure, format via library calls).** Rejected: enterprise C# developers expect `${x:N2}`/`${x,10}` inline; pushing them to `String.Format` calls is the regression ADR-0007 explicitly argued against for interpolation itself.
