# ADR-0179: `gsfmt` — one canonical G# form, one formatting engine

- **Status**: Proposed
- **Date**: 2026-09-05
- **Related**: ADR-0115 §B canonical G# output; ADR-0169 analyzer framework; ADR-0027 no Roslyn in gsc. Issues #916 (G# formatter), #892 (`var`→`let`), #1660 (range formatting withdrawn), #3501 (self-migration readability), #3931 (LanguageServer.Tests parity hang)

## Context

### G# has three formatters and no canonical form

| authority | indent | wraps? | input |
|---|---|---|---|
| `tools/cs2gs/Cs2Gs.CodeModel/Printing/GSharpPrinter.cs` (2,416 lines) | 4-space (ADR-0115 §B) | yes, ad-hoc, 120 cols | cs2gs emit AST |
| `src/LanguageServer/FormattingEngine.cs` (265 lines) | **2-space** default | no | token stream |
| hand-written `.gs` (`samples/`, `src/Sdk/Gsharp.Extensions/`) | 4-space | n/a | human |

They disagree. `FormattingEngine` reformatting an ADR-0115-conformant file changes
its indentation. This is not a metric problem; it is a language-deliverable gap. Go,
Rust, Zig and Swift all ship a formatter as part of the language. G# ships three
partial ones and advertises the weakest to editors.

The language server already exposes `textDocument/formatting`
(`ServerCapabilitiesFactory.cs:34`) and *deliberately withholds* `rangeFormatting`
and `onTypeFormatting`. The comment at `ServerCapabilitiesFactory.cs:57-61` says why:
issue #1660, because `FormattingEngine` only produces a correct whole-document
result. The handlers exist and are registered as no-ops (`LspServer.cs:685-690`). A
range formatter is not blocked by LSP plumbing — it is blocked by the engine having
no syntax tree.

### The #3501 long-line ratchet

`longLineCeiling` in `tools/cs2gs/selfmig-baseline.json` has been raised five times in
six days (560 → 575 → 580 → 610 → 640) and the count has never fallen: 544 → 554 →
563 → 572 → 595 → 602 → 630 (run 33943018295, 2026-09-05). The baseline file itself
twice says "if the next run lands near the ceiling, treat long lines as a real
regression, not a ratchet." It has landed near the ceiling three times.

The rises are individually justified — a correct `?` or `!!` costs characters — and
collectively a trend. `GSharpPrinter`'s response has been incremental:
`RenderWrappable`/`RenderWrapped` hand-code four break rules (`&&`/`||` chains,
leading-dot chains, argument lists, object initializers). That is a hand-rolled
partial Wadler pretty-printer, and extending it one shape at a time is the drift, not
the cure.

### What the 630 long lines actually are

Measured over the `cs2gs-selfmig-migrated` artifact of run 33943018295 (3,806 `.gs`
files). For each line, take the widest atomic token (string literal or dotted
identifier); a formatter can never get the line under 300 if
`indent + 8 + widest_atom > 300`.

| category | count | share | addressable by a formatter |
|---|---:|---:|---|
| wrappable code | 537 | 85% | **yes** (ideal upper bound) |
| one string literal wider than the budget | 61 | 10% | **no** |
| `///` doc comments | 32 | 5% | **no**, and should not be |

Shapes among the 537: member/call chains 201, argument lists 116, collection/object
literal braces 105, `+` concatenation chains 68, `&&`/`||` 5, other 39. The `&&`/`||`
figure is low *because* the existing `RenderWrapped` already handles it — direct
evidence that the remaining three families are unimplemented, not intractable.

**537 is an upper bound, not a forecast.** It assumes breaking is legal at every
inter-atom position and that continuation indent never exceeds +8. Neither holds
everywhere (see the newline-significance list below), and some breaks that fit the
budget read worse than the long line. A realistic post-wrapping figure is **400–480
fixed, leaving 150–230** — roughly two thirds of the metric, not all of it.

**The other 93 are not gsfmt's job and must not be assigned to it.**
`GSharpPrinter.RenderLiteral` already emits Go-style backtick raw strings for
multi-line literals, but guards on the value containing no backtick — and G#'s
backtick raw string has no escape, so a C# test fixture whose own comments contain a
backtick (for example
`test/Core.Tests/.../Issue3705MemberKindNullabilityDifferentialTests.cs:99`) falls
back to a 5,122-character escaped one-liner. Separately, cs2gs collapses an eight-line
`<remarks>` block into a single 424-character `///` line. Both are cs2gs emission
defects with cheap fixes (Phase 9), and fixing them is *faster* than the formatter.

> **Correction (Phase 9 implementation, #3950).** The 32 doc-comment lines and the
> 61-line string category above both survive re-measurement, but the **~93 does not**:
> those two numbers do not add up to a single fix budget. Only the multi-line *and*
> backtick-bearing subset of the 61 is spellable as a raw string — **30 lines** on the
> same artifact. The rest are interpolated strings (15) and single-line literals (12),
> which no raw-string spelling can shorten; `${…}` holes are not `LiteralExpression`s
> and never reach `RenderLiteral` at all. Phase 9 is therefore
> worth **~62**, not ~93, and the residual irreducible floor is ~27 lines rather than
> ~0. The measured result of implementing it, on a local `--translate-only` pass over
> the same corpus, is **631 → 565 (−66)**; the local scale runs ~4 above the nightly's
> because it skips stage 2's `!!` polish. Nothing else in this section moved: the
> wrappable-code count re-measures at 538 against the stated 537.
>
> One scale note, because it bit this measurement. The counter is
> `awk 'length($0)>300'`, and `length` counts **characters** under CI's UTF-8 locale
> but **bytes** under macOS's `awk`. The same artifact reads 627 one way and 630 the
> other — which is why this section says 630 while the gate that produced the artifact
> reported 626. Any local before/after must be taken in the character scale to be
> comparable to `longLineCeiling`.

### Is the syntax tree formattable at all?

**The tree is not full-fidelity. The token stream is.**

`SyntaxToken` carries `Kind`, `Position`, `Text`, `Value`, `IsMissing` — and no
trivia. `Parser`'s constructor (`Parser.cs:150-160`) drops `WhitespaceToken`,
`CommentToken` and `BadToken` outright, and side-channels `DocumentationCommentToken`
for `DocumentationAttacher`. `SyntaxNode.ToString()` is a Minsk-style indented tree
dump; there is no `ToFullString` and no `FullSpan`.

But `SyntaxTree.ParseTokens(SourceText)` returns **every** token the lexer produced —
whitespace (with line breaks folded into `.Text`), `//`, `/* */`, `///`, bad tokens —
each with an absolute `Position` and verbatim `Text`. `Lexer.GetTrivialText`
explicitly notes it keeps `WhitespaceToken`/`CommentToken` `.Text` verbatim to
preserve user line breaks and comment content. `FormattingEngine` already relies on
this.

So a formatter can recover trivia by *position-joining* two passes over the same
text: parse for structure, `ParseTokens` for the lexical stream, then attach each
non-significant token to the significant token that follows it. This is mechanical
and does not require modifying `SyntaxToken` or any of the 156 `*Syntax.cs` node
classes.

Two hazards this reveals, both real and both bounded:

- Interpolated-string holes are re-parsed from a sub-range of the outer text
  (`Parser(tree, start, end)`, issue #1605), so token positions inside `${…}` come
  from a *second* lexer pass. Position-joining must treat an `InterpolatedStringToken`
  as one opaque atom and never format inside it.
- `ParseTokens` builds an empty `CompilationUnitSyntax` and a throwaway `SyntaxTree`;
  the two passes must run over the same `SourceText` and be reconciled by offset, not
  by object identity.

### G# is newline-insensitive — except in nine places

`Parser.Expressions.cs:469` states the language is otherwise newline-insensitive. The
exceptions, found by grepping the parser for `IsTokenOnNewLineAfter` / `GetLineIndex`:

| site | rule |
|---|---|
| `Parser.Expressions.cs:292` | a line break after `..` terminates an open range |
| `Parser.Expressions.cs:457,473` | leading `*` on a new line is a deref continuation, not multiplication |
| `Parser.Expressions.cs:830` | postfix continuation cutoff |
| `Parser.Expressions.Creation.cs:728,842,1566` | `{` on a new line after `)` is not an object initializer |
| `Parser.Expressions.Literals.cs:1049` | anonymous-class member continuation |
| `Parser.Patterns.cs:323,427` | pattern/type-trial splits |
| `Parser.Statements.cs:1429,1493,1511` | bare vs. expression-carrying `return`/`break`-family |

**This is the single hardest correctness constraint in the design, and it is
currently undiscoverable.** A layout engine that breaks at any of these positions
silently changes program meaning. `GSharpPrinter`'s comments hint at it
("continuations gsc's parser accepts") but the knowledge lives in prose.

## Decision

Ship **`GSharp.Formatting`**, a library that owns the canonical G# form, and
**`gsfmt`**, a thin CLI over it. Both are new; neither is an extraction of an existing
component.

### D1. Library first, tool second — the `go/format` + `cmd/gofmt` shape

- `src/Formatting/GSharp.Formatting/` — references `GSharp.Core` only. Public surface
  is deliberately tiny:

  ```csharp
  public static class GSharpFormatter
  {
      public static FormatResult Format(SourceText text);               // whole document
      public static FormatResult Format(SourceText text, TextSpan span); // range
  }

  public readonly record struct FormatResult(
      SourceText? Text,
      ImmutableArray<TextEdit> Edits,
      ImmutableArray<Diagnostic> Diagnostics,
      bool Changed);
  ```

- `src/Formatting/Gsfmt.Cli/` — `AssemblyName=gsfmt`, `PackAsTool`,
  `PackageId=Gsharp.Gsfmt`, `ToolCommandName=gsfmt`, following
  `tools/cs2gs/Cs2Gs.Cli/Cs2Gs.Cli.csproj`.

**The language server references the library in-process, not the tool.** This
contradicts the "standalone tool that the LS consumes" framing, and the contradiction
is deliberate: `LspServer.FormatDocument` already calls `FormattingEngine.Format`
synchronously, the LS already hosts all of `GSharp.Core`, and formatting a document
needs a parse it has usually already done. A subprocess would add process-start
latency and a serialization boundary per save for no benefit, and would put a
`dotnet tool` install on the LS's critical path. `gopls` links `go/format`; it does
not shell out to `gofmt`. So does this design.

`gsfmt` remains genuinely standalone and shippable — for CI, pre-commit hooks,
`dotnet gsfmt`, and cs2gs.

**cs2gs consumes the library too, as a post-pass, not as a replacement.**
`GSharpPrinter` keeps deciding *which construct to emit*; it stops deciding *how it is
laid out*. After printing, cs2gs runs `GSharpFormatter.Format` over the emitted text.
If the text does not parse, cs2gs keeps the printed form and records a triage record —
**fail-soft, never fail-closed**, because a migrated app that does not compile must not
also lose its output. This yields a new, free, high-value signal: *N migrated files do
not round-trip through gsc's own parser*, a stricter emission check than anything
cs2gs has today.

### D2. Zero options. No config file. Line width fixed at 120

`gofmt`'s defining property. Adopted, and the repo supplies the argument for it:
`FormattingEngine` took an `indent` parameter, LSP `FormattingOptions.tabSize` was
threaded into it, and G# consequently has a 2-space canonical form in editors and a
4-space one on disk. A half-configurable formatter produced exactly the divergence a
formatter exists to prevent.

Concretely:

- No `gsfmt.json`. No `[*.gs]` layout keys in `.editorconfig`. Nothing in
  `.gsproj`/`.csproj`.
- `.editorconfig` stays what ADR-0169 and `EditorConfigSeverityReader.cs` already made
  it: **diagnostic severities only**. Layout is not a diagnostic.
- **`gsfmt` and the LS ignore LSP `FormattingOptions`** (`tabSize`, `insertSpaces`,
  `trimTrailingWhitespace`). `gopls` does the same. This is a user-visible behaviour
  change for anyone who set a tab size; it is called out in the release note.
- The one number, 120, is a compile-time constant, chosen because
  `GSharpPrinter.MaxLineWidth` already is 120 and the migrated corpus is already
  partly shaped to it. It is not exposed.

The canonical form is ADR-0115 §B, promoted from "the contract the cs2gs
pretty-printer must satisfy" to "the definition of formatted G#": 4-space indent, no
tabs, K&R braces, one blank line between sibling members, no trailing whitespace, file
ends in exactly one `\n`.

### D3. Wadler/Oppen `Doc` algebra, not Roslyn-style formatting rules

Recommended: a `Doc` algebra — `Text`, `Line`, `SoftLine`, `Nest(n, doc)`,
`Group(doc)`, `Concat` — with Wadler's `fits`-driven flattening: a `Group` renders
flat if it fits the remaining budget, otherwise every `Line` inside it breaks.

Rejected: Roslyn's model (`AbstractFormattingRule` + `TriviaData` + operation
providers). It is the closest technical prior art and it is the wrong tool, for a
specific and checkable reason: **Roslyn's formatter preserves the author's line breaks
and only normalises spacing and indentation. It does not choose where to wrap.** That
is why `dotnet format` has never shortened a long line in anyone's C#. Adopting it
would leave the 537 exactly where they are.

Further reasons to prefer the algebra:

1. The dominant shapes are *nested* — a member chain whose links carry argument lists
   whose arguments are object literals (201 + 116 + 105 of the 537). `Group` composes;
   hand-written rules do not. `RenderWrapped` already shows the failure mode: it must
   re-check `text.IndexOf('\n') < 0` and bail out of recursion to avoid dropping
   precedence parentheses.
2. It is small. Wadler's core is ~300 lines. The cost is in the ~156 node layout
   rules, which every design pays.
3. It makes idempotence structural rather than accidental: layout is a pure function
   of the tree plus the width, so `format(format(x))` re-derives the same `Doc`.

**`SyntaxFacts` newline-significance is a hard prerequisite (Phase 1, not later).**
The nine parser sites above become a shared, tested surface in `GSharp.Core`:

```csharp
public static bool IsBreakLegalBetween(SyntaxToken left, SyntaxToken right);
public static bool IsBreakRequiredBetween(SyntaxToken left, SyntaxToken right);
```

The `Doc` builder may only emit `Line`/`SoftLine` where `IsBreakLegalBetween` is true;
everywhere else it emits `Text`. A test asserts that every `IsTokenOnNewLineAfter` /
`GetLineIndex` call site in `src/Core/CodeAnalysis/Syntax/Parser*.cs` is represented,
so a future newline-sensitive grammar rule cannot be added without the formatter
learning about it. This test is the most valuable single artifact in the design.

### D4. Correctness: three invariants, each a gate

1. **Idempotence.** `Format(Format(x)) == Format(x)`, byte for byte, over every `.gs`
   in the repo and every file of the migrated tree. Enforced by making
   `gsfmt --check` re-run itself once in CI.
2. **Semantic preservation — token-stream equality.** Re-lex the formatted text and
   compare the *significant* token sequence (`Kind` + value text, excluding
   whitespace) to the original's, plus multiset equality of comment texts. Stronger
   and cheaper than tree comparison: it catches dropped tokens, inserted tokens,
   mutated literals and lost comments, which are the entire realistic bug class. Tree
   comparison is *added on top* for the newline-significant sites, where token-stream
   equality is by construction blind (`a?[i]` vs `(a?[i])` differ in tokens;
   `return\nx` vs `return x` do not).
3. **Emit-level oracle over `samples/`.** The `samples/*.gs` files have checked-in
   **stdout** `.golden` files. Format all of them, build, run, and require
   byte-identical goldens. This repo's recorded lesson is that binding-only checks
   miss emit bugs. Because the goldens are program output rather than source layout,
   reformatting `samples/` costs *zero* golden churn and buys a real end-to-end
   semantic oracle. Wire it in Phase 2, before any wrapping exists.

### D5. Lint stays out. Explicitly

**`gsfmt` does formatting only. Every lint rule belongs to the ADR-0169 analyzer
framework.**

- ADR-0169 already built the thing: `GSharpDiagnosticAnalyzer`, the Roslyn-shaped
  context/registration surface, `/gsdiag:<ID>=<severity>`, `.editorconfig` severity
  reading in the SDK, and GS93xx diagnostics for analyzer misbehaviour. A second
  diagnostic system in `gsfmt` would need its own IDs, severities, suppression story
  and LSP surface — all duplicated.
- Lints need **semantics**; formatting must not. Issue #892 (linter should autoconvert
  `var` to `let` when not mutated in scope) is the canonical example: it requires
  definite-assignment data flow. A formatter with a binder is not a formatter; it is a
  compiler pass with a bad name, it cannot run on a file that does not bind, and it
  cannot meet the "never changes semantics" invariant — because changing `var` to
  `let` *is* a semantic edit.
- The invariants differ irreconcilably. A formatter must never change the token
  stream. A linter's whole purpose is to propose changes to it. Folding both into one
  binary means one of the two invariants is false, and users cannot tell which.
- Editor integration already separates them: format-on-save runs
  `textDocument/formatting`; lints arrive as `textDocument/publishDiagnostics` with
  `textDocument/codeAction` fixes. Both endpoints exist.

Consequence: **#892 is retargeted to ADR-0169 as an analyzer plus code fix.** #916 is
adopted by this ADR.

One deliberate exception, and it is not a lint: `gsfmt` sorts imports and collapses
duplicate blank lines, because both are pure layout of the `import` block and
ADR-0115 §B.1 already specifies the block's shape. It does **not** remove unused
imports — that is semantic, and it is an analyzer.

### D6. CLI surface

```
gsfmt [flags] [path ...]        # paths default to "."; directories recurse for *.gs
  -w, --write        rewrite files in place (default: write result to stdout)
  -l, --list         print names of files that are not formatted (gofmt -l)
      --check        exit 1 if any file would change; print nothing else (CI)
  -d, --diff         print a unified diff instead of the result
      --stdin-name   filename to report for diagnostics when reading stdin
```

- No path arguments and stdin not a TTY → read stdin, write stdout. Used by
  pre-commit hooks and by editors that prefer a pipe.
- Exit codes: `0` formatted / no changes needed; `1` `--check` found unformatted
  files; `2` a file failed to parse or an I/O error occurred. `--check` failure and a
  parse error are distinguishable, which `gofmt` gets wrong.
- Exclusions: `.gsfmtignore`, gitignore syntax, nearest-ancestor lookup.
  Always-excluded regardless: `*.g.gs` (generated, per ADR-0169's generated-code
  convention), `bin/`, `obj/`, `out/`.
- **No `--fix`, no `--rule`, no `--config`.** The absence is the feature.

### D7. Distribution

- `src/Formatting/GSharp.Formatting/` and `src/Formatting/Gsfmt.Cli/`. Under `src/`,
  not `tools/`: it is a language deliverable shipped to users, like `src/Repl` and
  `src/Compiler`. `tools/` is build-time machinery.
- Packed two ways, mirroring `Cs2Gs.Cli`: `Gsharp.Gsfmt` as a `dotnet tool`
  (`dotnet tool install -g Gsharp.Gsfmt` → `gsfmt`), and `GSharp.Formatting.dll`
  inside the `Gsharp.NET.Sdk` nupkg so the SDK can invoke it without a tool install.
- MSBuild: a `GsharpFormatCheck` target in the SDK targets, **off by default**,
  opt-in via `<GsharpFormatOnBuild>true</GsharpFormatOnBuild>` — check-only; a build
  must never rewrite sources.
- `dotnet format` integration is explicitly **not** pursued: it is
  Roslyn/`Microsoft.CodeAnalysis`-bound, and ADR-0027 bars Roslyn from `gsc`'s graph.

### D8. Language: C# first, migrate later, guarded from day one

`GSharp.Formatting` is authored in C#, referencing `GSharp.Core` (C#), and is added
to `build/run-cs2gs-selfmig-pr-guard.sh`'s `guard_apps` **in the PR that creates it** —
not later.

Rejected: authoring in G# from the outset. It creates a build cycle with no payoff —
`gsc` must compile gsfmt, gsfmt's dependency `GSharp.Core` is C#, and gsfmt's own
sources would have to be formatted by a gsfmt that does not yet build. Go bootstrapped
`gofmt` in C-translated Go, not in Go-from-day-one. G# reaches the same destination
through the self-migration it already runs nightly, at zero extra cost.

Accepted cost, stated plainly: **gsfmt enters the cs2gs migration corpus by
existing.** This has taken the nightly gate down four times (#3831, #3896, #3905,
#3915). Mitigations, all mandatory:

- `guard_apps` gains `GSharp.Formatting` in Phase 1. `verify_closure()` requires the
  list be closed under `ProjectReference`; `GSharp.Core` is already there, so the
  closure is satisfied by adding one entry.
- Once cs2gs references the library (Phase 7) it is guarded transitively — but it must
  be guarded *before* that, in Phase 1, so a translation failure surfaces on a small
  PR rather than as a cascade.
- **Style constraint:** `GSharp.Formatting` is written in the C# subset that
  `Cs2Gs.CodeModel` and `Cs2Gs.Translator` already prove translatable (both are in
  `greenApps`). No new language shapes. If a construct will not translate, it does not
  go in the formatter — the formatter is not the place to discover translator gaps.

## Alternatives considered and rejected

**A. Extract and generalise `GSharpPrinter`.** Rejected on input model. It consumes
`Cs2Gs.CodeModel`, a translator-specific emit AST with no notion of a `.gs` file, no
comments (cs2gs attaches those from Roslyn trivia at translation time) and no
positions. Formatting an existing `.gs` file through it means parsing G# and
reconstructing a `CodeModel` — a second lossy mapping through a model never designed
as a target. It is an emitter, not a formatter, and the distinction is that a
formatter's input is text it must not change.

**B. Grow `FormattingEngine` into the formatter.** Rejected on capability. It is a
token-stream rewriter with no tree, so it cannot know a `,` is an argument separator
rather than a tuple separator, cannot compute a subtree's flat width, and therefore
cannot wrap. Issue #1660 already recorded the consequence — range formatting was
withdrawn because a whole-token-stream engine cannot produce a correct partial result.
`FormattingEngine` is deleted in Phase 5.

**C. Roslyn-style formatting rules.** Rejected: see D3. Roslyn's formatter does not
wrap, and wrapping is 85% of the value.

**D. `gsfmt` as a subprocess the LS shells out to.** Rejected: see D1. The LS already
formats in-process, correctly, today.

**E. Add `LeadingTrivia`/`TrailingTrivia` to `SyntaxToken` (true full fidelity).**
Rejected *for now*, and this is the closest call in the ADR. It is the
architecturally right shape and would make the formatter simpler. It also touches all
156 `*Syntax.cs` classes, every `SyntaxKind`, `Span`/`ComputeSpan` and its cache,
`DocumentationAttacher`, the reflection-driven `GetChildren`, the interpolated-string
sub-range parser, and every consumer of `.Span` in the binder, LS and analyzers —
while `ParseTokens` already provides losslessness for free. Deferred, not refused: if
the position-joining trivia binder proves fragile in Phase 1, this ADR should be
superseded rather than worked around.

**F. Configurable formatter (`.editorconfig` or `gsfmt.json`).** Rejected: see D2. The
2-space/4-space split is the in-repo proof of what options cost.

**G. Do nothing; keep hardening `RenderWrapped` shape by shape.** Rejected. It is the
current strategy, it has produced five ceiling raises and zero reductions, and it
fixes the metric only in cs2gs output — hand-written G# and the language server get
nothing.

## Phased plan

Each phase is one mergeable, independently testable PR unless noted. Phases 1–3 have
no consumer and cannot regress anything.

| # | Phase | Content | Gate added |
|---|---|---|---|
| 1 | Foundations | `GSharp.Formatting`; `Doc` algebra + Wadler renderer; trivia binder over `ParseTokens`; `SyntaxFacts.IsBreakLegalBetween`/`IsBreakRequiredBetween`; parser-call-site coverage test. Add to `guard_apps`. | newline-site coverage |
| 2 | Declarations | Layout for compilation unit, `package`/`import`, types, members, doc comments. No wrapping. Wire the `samples` stdout-golden emit oracle. | idempotence; token-stream equality; samples goldens |
| 3 | Statements & expressions | The remaining ~120 node layouts. Still no wrapping — one statement per line, canonically spaced and indented. | repo-wide round-trip |
| 4 | `gsfmt` CLI | `Gsfmt.Cli`, `PackAsTool`, `-w/-l/--check/-d`, stdin, recursion, `.gsfmtignore`. SDK `GsharpFormatCheck` target (opt-in). | — |
| 5 | Language server | `FormattingEngine` deleted; LS calls `GSharpFormatter`. **Enable `rangeFormatting`** (closes #1660's caveat) and `onTypeFormatting`. VS Code extension defaults `editor.formatOnSave` for `.gs`. Ignore `FormattingOptions`. Release-note the 2→4 space change. | LS formatting tests (see risks: #3931) |
| 6 | Wrapping (2 PRs) | 6a: `Group`/`Nest` on argument lists and member chains (317 of 537). 6b: collection/object literals and `+` chains (173). Measured against the migrated tree each time. | line-width property test |
| 7 | cs2gs adoption (2 PRs) | 7a: format-as-post-pass behind `--format`, off by default; run the corpus, publish the diff and the round-trip failure count. 7b: flip on; absorb golden churn; delete `RenderWrappable`/`RenderWrapped`. | migrated-tree round-trip count |
| 8 | Repo adoption | `gsfmt -w` over hand-written `.gs`; CI `gsfmt --check`. | `gsfmt --check` in CI |
| 9 | The other 62 | 9a: cs2gs preserves doc-comment line structure (−32). 9b: backtick-safe raw strings — split a literal containing a backtick into concatenation, as Go does (−30, not −61: see the correction above). **DONE, #3950**, measured 631 → 565 locally. | — |

**Sequencing note:** Phase 9 was listed last but had the best ratio in the plan — one
small, self-contained cs2gs PR removing ~62 long lines that no formatter work can
touch. It was **done first**, for exactly that reason — and it is what finally made
`longLineCeiling` go **down** (640 → 580) after six consecutive raises.

### Golden churn, phase by phase

- Phases 1–4: none. No existing output changes.
- Phase 5: `FormattingEngineTests.cs` is deleted and rewritten; `LspServer` formatting
  expectations change from 2-space to 4-space.
- Phase 6: none in-repo (the printer is untouched until Phase 7).
- **Phase 7 is the large one.** 454 `GSharpPrinter.Print` call sites and ~4,756
  assertions across 455 `Cs2Gs.Tests` files. Most assert `Assert.Contains` on short
  fragments and survive re-layout; the exposure is whole-file `Assert.Equal`.
  Mitigation: 7a runs the corpus and publishes the exact churn count *before* 7b
  commits to it, so the size is known rather than discovered.
  `code-model-surface.golden.txt` and `roslyn-surface.golden.txt` are API-surface
  goldens, not layout — untouched. `corpus/**/baseline.stdout.golden` and
  `baseline.tests.json` are behaviour goldens — untouched if the invariants hold, and
  any movement is a **bug**, not churn.
- Phase 8: touches `.gs` sources only; `samples/*.golden` are stdout, so they must not
  move. Again, movement is a bug.

### `selfmig-baseline.json` transition

0. Phase 9 landed first and did change migrated output: `longLineCeiling` 640 → 580
   in #3950, measured 631 → 565 on a local `--translate-only` pass over the corpus.
1. Phases 1–6 do not change migrated output; ceilings untouched.
2. Phase 7b lands with a re-baseline in the same PR, per the file's stated discipline
   ("improve a metric, then tighten the corresponding number in the same PR").
   `longLineCeiling` drops to the measured value plus the conventional margin.
3. **Change what the metric measures.** Once the formatter owns wrapping, split the
   counter in `build/cs2gs-counters.sh` into `lines>300 (reducible)` and
   `lines>300 (single-atom-bounded)`. Only the reducible count is ratcheted; the
   irreducible count is reported — because ratcheting a number nobody can move is how
   a gate teaches people to raise ceilings. This also fixes a live inconsistency:
   `cs2gs_counter_report` labels the long-line row "code" but computes it from
   `cs2gs_raw_lines`, so comments and string-bearing lines are counted while the `!!`
   row excludes them (filed as #3949, deliberately not fixed alongside the phase-9
   improvement).
4. `longLineCeiling` is **not** retired. Wrapping is a property of emitted code and
   can still regress.

## Risks

| risk | severity | mitigation |
|---|---|---|
| Formatter changes program semantics at a newline-significant site | **critical** | `IsBreakLegalBetween` in Phase 1; parser-call-site coverage test; tree comparison on top of token-stream equality; `samples` emit oracle |
| gsfmt breaks the nightly gate by existing (#3831/#3896/#3905/#3915) | high | `guard_apps` from Phase 1; C# subset restricted to what `Cs2Gs.CodeModel` proves translatable |
| Position-joining trivia binder is fragile (interpolated-string sub-ranges, #1605) | high | Phase 1 is a spike whose exit criterion is round-tripping every `.gs` in the repo; if it fails, escalate to alternative E |
| Phase 7 golden churn larger than estimated | medium | 7a measures before 7b commits; churn lands in one mechanical PR |
| LS formatting tests cannot be validated — migrated `LanguageServer.Tests` already exceeds the 10-minute parity budget (#3931) | medium | Phase 5 depends on #3931; do not add tests to that project until it is fixed, or the parity numbers become truncation artifacts |
| Users lose their configured indent width | low | ignoring `FormattingOptions` is stated in the release note; it is the point of D2 |
| Formatter output uglier than hand-written G# somewhere | low | `samples/` reviewed by hand in Phase 8 before CI `--check` is enabled |

## Open questions

1. ~~Should Phase 9 be pulled ahead of Phase 1?~~ **Resolved: yes.** Done in #3950
   before any formatter work; `longLineCeiling` 640 → 580 in the same PR.
2. G#'s backtick raw string has no escape hatch, so a multi-line string containing a
   backtick is unspellable except as an escaped one-liner or a concatenation. Go has
   the same hole and lives with it. Is a `` ``` ``-fenced or `#`-delimited raw string
   worth a separate ADR?
3. Should `gsfmt` reflow `///` doc comments to the width (`rustfmt`'s `wrap_comments`,
   off by default)? Recommendation: **no** — reflowing a comment is editing prose. The
   32 long comment lines are cs2gs failing to preserve line structure it had, which is
   Phase 9a.
4. Blank-line policy: `gofmt` preserves author blank lines (collapsing runs to one);
   `GSharpPrinter` emits exactly one between members. Proposal: preserve up to one,
   insert one where ADR-0115 §B.2 requires. Needs a decision before Phase 2.
5. Does the SDK `GsharpFormatCheck` target ever become on-by-default for new projects
   from `Gsharp.Templates`? Deferred to post-Phase-8 data.
