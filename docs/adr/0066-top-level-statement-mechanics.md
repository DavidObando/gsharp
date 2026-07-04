# ADR-0066: Top-level statement mechanics in SDK-enabled projects

- **Status**: Accepted
- **Date**: 2026-06-10
- **Implemented**: 2026-06-10 (PR [#688](https://github.com/DavidObando/gsharp/pull/688))
- **Phase**: Phase 9 — language depth / entry-point clarity
- **Related**: ADR-0028 (multi-package emit), design doc [`design/Gsharp-design-v0.1.md`](../../design/Gsharp-design-v0.1.md) §"Entry-point synthesis rules", issue [#644](https://github.com/DavidObando/gsharp/issues/644)

## Context

G# inherits C# 9-style top-level statements (TLS): a `.gs` file may contain statements directly at the root, and the binder synthesizes a hidden entry-point method whose body is the lowered statement sequence. This was specified informally in `design/Gsharp-design-v0.1.md` and partially refined by ADR-0028 once a single `.gsproj` was allowed to carry multiple `package` declarations.

Today the contract is spread across three places that disagree at the edges:

- `design/Gsharp-design-v0.1.md` §"Entry-point synthesis rules" still says "exactly one **source file** with top-level statements; multiple files with top-level statements is a compile error" — this pre-dates ADR-0028 and is no longer accurate.
- ADR-0028 §Decision narrows it to "exactly one **package** with top-level statements" — that package owns the synthesized entry point — but does not enumerate the rest of the TLS contract.
- The binder (`src/Core/CodeAnalysis/Binding/Binder.cs:2794-2874`) implements the package-scoped rule, but the diagnostic text it reports (GS0165 in `src/Core/CodeAnalysis/DiagnosticBag.cs:874`) still reads "Only one source file in a compilation may contain top-level statements", which is what the design used to say, not what the binder actually checks.

Multi-file `.gsproj` projects are now common (the MSBuild SDK feeds every `.gs` file under the project into a single `Compilation`), so the question "when I add a second file, what is and is not allowed with respect to top-level statements?" needs a single authoritative answer. Issue #644 asks for that answer in ADR form, with diagnostics that help developers succeed rather than guess, and with test coverage for both the positive and the negative cases.

C# 9's top-level statement feature is the obvious starting point because (a) the existing G# implementation is already modeled on it and (b) the vast majority of G# users have a C# mental model. Where G# already aligns with C#, this ADR ratifies the alignment. Where G# diverges (or has not yet implemented a C# rule), this ADR records the decision explicitly so the divergence is intentional, not accidental.

## Decision

### Authoritative rules (Accepted — in force today)

1. **Single-package TLS rule.** Within a single compilation, at most one `package` may contribute top-level statements. Several `.gs` files inside that one package may each carry TLS; their statements are concatenated in deterministic order to form the synthesized entry-point body. Any other package in the same compilation may declare types, functions, and members but **must not** contain TLS. Supersedes the "exactly one source file" wording in `design/Gsharp-design-v0.1.md` §"Entry-point synthesis rules".

2. **Statement ordering across files (D7 — Accepted, implemented in commit `92b4163`).** When TLS span multiple `.gs` files in the entry-point package, the binder sorts contributing files by `SourceText.FileName` using `StringComparer.Ordinal` and concatenates statements from the sorted sequence; within each file, statements are bound in lexical source order. The sort makes cross-file TLS ordering identical regardless of how the build tool populates `@(Compile)`, how the command-line driver orders source-file arguments, or how a test permutes the input. In-memory `SyntaxTree.Parse(text)` calls (no `fileName`) sort stably among themselves by `SelectMany`'s iteration order.

3. **Entry-point synthesis.** When any TLS exist, the binder creates a hidden `FunctionSymbol` named `<Main>$` owned by the TLS-bearing package (the "entry-point package"). The emitter places it on that package's `<Program>` static type and marks it as the assembly's entry point. `<Main>$` is lexically not a legal user identifier and therefore cannot collide with anything a user writes.

4. **Conflict with an explicit `func Main` (D6 — Accepted as warning, implemented in commit `1620a6b`).** A compilation that contains both top-level statements and an explicit `func Main()` (or `func Main(args string[])`) anywhere — same file, different file in the same package, or even a different package — emits diagnostic **GS0166** as a **warning** ("Top-level statements cannot be used together with an explicit Main function."). The synthesized `<Main>$` becomes the entry point and shadows the explicit `Main`, matching C# CS7022's "warn-and-prefer-TLS" semantics. Compilation succeeds; the warning surfaces the conflict so the developer can either remove the TLS or remove the explicit `Main`.

5. **TLS spanning multiple packages.** A compilation in which two or more distinct packages each contribute top-level statements is rejected with diagnostic **GS0165**. As part of this ADR, GS0165's message text is corrected from "Only one source file in a compilation may contain top-level statements." to **"Top-level statements may appear in at most one package per compilation."** so the message matches what the binder actually checks. The diagnostic id and severity are unchanged.

6. **Explicit `func Main` shape.** When there are no TLS, the entry point is the user's `func Main`; existing rules in the binder govern its accepted arities and return type. Those rules are not changed by this ADR.

7. **Implicit `args` parameter (D1 — Accepted, implemented in commit `5fa184e`).** The synthesized `<Main>$` declares an implicit `string[] args` parameter. TLS may reference `args` as if it were a regular local; identifier resolution finds the parameter via the function-scoped binder that owns the synthesized entry point. The emitted CLR signature matches the standard `static T Main(string[])` shape the .NET runtime hosts.

8. **`int` return inference (D2 — Accepted, implemented in commit `209531c`).** The binder pre-scans TLS for `return` statements before binding. If any `return <expr>;` is present, the synthesized entry point's return type is inferred as `int` (so the CLR can surface the value as `Process.ExitCode`). If only bare `return;` (or no return) is present, the entry point stays `void`. If TLS mixes both shapes, diagnostic **GS0287** is reported at the first offender ("Top-level statements mix bare `return;` and `return <expr>;`. Choose one return shape so the synthesized entry point has a single return type."), and the first-seen shape wins for recovery.

9. **`async` entry point from `await` in TLS (D3 — Accepted, implemented in commit `386144c`).** The pre-scan from rule §8 also looks for `await` expressions. If any are found, the synthesized `<Main>$` is marked `IsAsync = true`. The existing async-state-machine lowering (ADR-0023) takes over from there and wraps the kickoff method's return type as `Task` (when §8 chose `void`) or `Task<int>` (when §8 chose `int`). The CLR's image loader rejects entry points returning `Task`/`Task<int>` directly ("Entry point must have a return type of void, integer, or unsigned integer"); C# emits a synthetic sync wrapper to satisfy the loader. **Resolved (issue #1904):** the emitter now recognizes when the async kickoff method IS the CLR entry point and, in that one case, drives the state machine's `Task`/`Task<T>` synchronously in place — `GetAwaiter()` then `GetResult()` on the same call site — instead of returning the task; the method's CLR signature stays the function's own declared `void`/`int32` shape (never `Task`-typed), so no separate wrapper method is synthesized. This affects both `async` TLS and user-authored `async func Main()` identically, since both lower through the same kickoff-body emission path. See `test/Compiler.Tests/Emit/Issue1904AsyncEntryPointEmitTests.cs`.

10. **TLS in a library compilation (D4 — Accepted, implemented in commit `865cc2c`).** A compilation whose `Compilation.IsLibrary` flag is set and that contains any TLS is rejected with diagnostic **GS0285** ("Top-level statements are not allowed in a library project. Set <OutputType>Exe</OutputType> on the project, or move the statements into an explicit `func Main()`."). The diagnostic is reported once at the first global statement; binding continues so downstream consumers see a complete bound tree. The compiler driver (`src/Compiler/Program.cs`) sets `compilation.IsLibrary = true` whenever `/target:library` is passed; the MSBuild SDK forwards `OutputType` to `/target` transparently.

11. **Interleaved TLS and declarations within one file (D5 — Accepted as warning, implemented in commit `2a8d0a5`).** Within a single `.gs` file, TLS must form a single contiguous block. Both the C# style (TLS at the top, then declarations) and the Go style (declarations at the top, then trailing TLS) are accepted without diagnostic — the Go style is the prevailing G# idiom across ~488 sources in `samples/` and test fixtures. Layouts that interleave a declaration *between* two TLS blocks emit diagnostic **GS0286** ("Top-level statements should form a single contiguous block within a file — interleaving them with type or function declarations is hard to read.") as a **warning**, surfacing the unusual layout without breaking compilation. This is the relaxed, G#-flavored variant of C#'s strict "TLS must precede type declarations" rule; the strict version is incompatible with G#'s established culture.

### Deferred decisions (none remaining)

All seven decisions originally recorded as Deferred (D1 implicit `args`, D2 `int` return, D3 `async Task[<int>]`, D4 library guard, D5 contiguous-TLS rule, D6 warn-prefer-TLS, D7 canonical ordering) have been promoted into the Authoritative rules above and implemented in PR [#688](https://github.com/DavidObando/gsharp/pull/688). The only known remaining gap vs C# is the **async entry-point sync wrapper** noted in rule §9: the G# emitter does not yet emit the synthetic sync wrapper that the CLR loader needs for `Task`-returning entry points, so runtime execution of async TLS requires a future emitter change. That gap also affects user-authored `async func Main()` and so is tracked outside this ADR's scope.

## Consequences

**Positive:**

- One authoritative document answers "what does TLS do when I add a second `.gs` file?" — replacing today's three partially-overlapping sources.
- The GS0165 message text becomes truthful, reducing developer confusion when the diagnostic fires.
- Deterministic cross-file ordering is pinned down via path-sort (rule §2), making same-package multi-file TLS programs reproducible across rebuilds, filesystems, and tools.
- All seven originally-deferred decisions are now Accepted and implemented, closing the gap with C# 9's TLS feature (except for the async-entry-point sync wrapper noted in rule §9).
- `args` is now a first-class implicit local in TLS; `int` and `Task[<int>]` returns are inferred from TLS shape; library compilations that contain TLS fail with a clear actionable diagnostic.

**Negative:**

- The async-entry-point sync wrapper is still missing from the emitter (rule §9 caveat), so TLS that uses `await` builds cleanly but the produced assembly will not load — the same gap affects user-authored `async func Main()`. A follow-up emit-side PR is needed.

**Neutral:**

- The GS0165 message-text edit was the only behavioral change in the original ADR PR; subsequent commits introduced GS0285 (TLS in library), GS0286 (interleaved TLS warning), GS0287 (mixed return shapes), and demoted GS0166 to a warning.
- ADR-0028's narrowing of the TLS rule to "one package" is preserved unchanged; this ADR reaffirms it and elevates it to the canonical phrasing.

### Gap matrix vs C# 9 top-level statements

| Area | C# behavior | G# today | This ADR |
| --- | --- | --- | --- |
| TLS across files in same package | Statements concatenate in file order | Sorted by source path then bound in lexical order | Accepted (rule §2 / D7) |
| TLS spanning multiple packages | N/A (C# has no "package") | Error GS0165 | Accepted (rule §5); message text corrected |
| TLS + explicit `Main` | Warning CS7022, TLS wins | Warning GS0166, TLS wins | Accepted (rule §4 / D6) |
| Implicit `args` | `string[] args` in scope | `string[] args` in scope | Accepted (rule §7 / D1) |
| `int` return from TLS | Inferred → `int <Main>$` | Inferred → `int <Main>$` (GS0287 on mixed shapes) | Accepted (rule §8 / D2) |
| `await` in TLS | Lifted to `async Task[<int>]` | Lifted to `async Task[<int>]` *(emit-side sync wrapper still missing)* | Accepted (rule §9 / D3); known emit gap |
| TLS in `OutputType=Library` | Error CS8805 | Error GS0285 | Accepted (rule §10 / D4) |
| TLS ordering inside one file | TLS must precede type decls | TLS must form a contiguous block (Warning GS0286 on interleave; both Go and C# styles accepted) | Accepted (rule §11 / D5) — relaxed from C# to fit G#'s established idiom |
| Synthesized entry-point name | `<Main>$` reserved | `<Main>$` reserved | Accepted (rule §3) |
| TLS-declared locals visibility | Method-scoped, not exported | Method-scoped, not exported | Accepted (matches C#) |

## Alternatives considered

- **Inline the TLS contract into `design/Gsharp-design-v0.1.md` instead of an ADR.** Rejected: the design doc is the v0.1 historical record (see ADR-0010 on its role); landing decisions there mixes "what we shipped first" with "what we have decided since." ADRs are the right home for evolving decisions, and ADR-0028 already set the precedent for refining the v0.1 entry-point story this way.

- **Forbid multi-file TLS entirely and require all TLS to live in one file.** Considered for simplicity. Rejected: ADR-0028's multi-package model already allows the entry-point package to span multiple files for non-TLS members, and arbitrarily forbidding multi-file TLS would force developers to merge files for unrelated reasons. Deterministic ordering (rule §2) gives us reproducibility without that ergonomic cost.

- **Implement all six C#-faithful rules (D1–D6) in the same PR that lands the ADR.** Initially rejected by the request author so the ADR could land first as a standalone design artifact. In a follow-up round (the back half of PR #688), all seven deferred decisions were dispatched to three parallel Opus sub-agents working in isolated `git worktree`s — Agent A took the entry-point feature stack (D1+D2+D3+D6), Agent B took the library guard (D4), Agent C took the parser ordering (D5), and the integrator did D7 inline. D5 was relaxed from the C#-strict "TLS must precede declarations" rule to the G#-flavored "TLS must be contiguous" warning to honor G#'s established Go-style trailing-TLS idiom (488+ sources).

- **Make GS0166 a warning today (matching C#'s CS7022) without implementing D1–D5 first.** Initially rejected because prefer-TLS-silently is only ergonomic if TLS can actually express everything `Main` can (args, int return, async). With D1/D2/D3 now landed (rules §7–§9), the precondition is met and D6 was implemented in the same PR.

- **Adopt C#'s strict "TLS must precede type declarations" rule for D5.** Rejected mid-implementation: the strict rule produced 471 failing tests against G#'s prevailing decls-first / trailing-TLS idiom (~488 source files across `samples/` and test fixtures use this layout). The relaxed "TLS must be contiguous" warning catches the genuinely confusing interleaved case without forcing a coordinated rewrite of the existing corpus. Recorded as the variant in rule §11.

## Acceptance

- This ADR file exists at `docs/adr/0066-top-level-statement-mechanics.md`.
- `design/Gsharp-design-v0.1.md` §"Entry-point synthesis rules" cross-references this ADR as the authoritative source.
- `docs/diagnostics.md`'s GS0165 row matches the corrected message text in `DiagnosticBag.cs`.
- `test/Core.Tests/CodeAnalysis/Binding/BinderEntryPointTests.cs` contains positive and negative tests for each Accepted rule (§§1–6 above) — including the deterministic-ordering rule (§2), the conflict rule (§4) across same-file, cross-file, and cross-package shapes, and the three-package variant of the multi-package rule (§5).
- `test/Compiler.Tests/Emit/TopLevelStatementEmitTests.cs` provides one end-to-end emit smoke test confirming a TLS-only program compiles, IL-verifies, and runs.
- Full test suite (`dotnet test GSharp.sln --no-restore --nologo`) stays green.
