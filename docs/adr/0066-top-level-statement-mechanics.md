# ADR-0066: Top-level statement mechanics in SDK-enabled projects

- **Status**: Accepted
- **Date**: 2026-06-10
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

2. **Statement ordering across files.** When TLS span multiple `.gs` files in the entry-point package, the binder concatenates them in the order the compilation receives the syntax trees: for the SDK build that is the order of MSBuild's `@(Compile)` items; for `gsc.dll` it is the order of source-file arguments on the command line; for tests it is the order passed to `Compilation`'s constructor. Within each file, statements are bound in lexical source order. This is the behavior shipped today; tightening it to a binder-canonical sort (e.g., ordinal source-path comparison) is captured as deferred decision D7 below.

3. **Entry-point synthesis.** When any TLS exist, the binder creates a hidden `FunctionSymbol` named `<Main>$` owned by the TLS-bearing package (the "entry-point package"). The emitter places it on that package's `<Program>` static type and marks it as the assembly's entry point. `<Main>$` is lexically not a legal user identifier and therefore cannot collide with anything a user writes.

4. **Conflict with an explicit `func Main`.** A compilation that contains both top-level statements and an explicit `func Main()` (or `func Main(args string[])`) anywhere — same file, different file in the same package, or even a different package — is rejected with diagnostic **GS0166** ("Top-level statements cannot be used together with an explicit Main function."). The synthesized `<Main>$` still becomes the entry point so the rest of binding can proceed, but the diagnostic is fatal at compile time.

5. **TLS spanning multiple packages.** A compilation in which two or more distinct packages each contribute top-level statements is rejected with diagnostic **GS0165**. As part of this ADR, GS0165's message text is corrected from "Only one source file in a compilation may contain top-level statements." to **"Top-level statements may appear in at most one package per compilation."** so the message matches what the binder actually checks. The diagnostic id and severity are unchanged.

6. **Explicit `func Main` shape.** When there are no TLS, the entry point is the user's `func Main`; existing rules in the binder govern its accepted arities and return type. Those rules are not changed by this ADR.

### Deferred decisions (recorded; implementation tracked separately)

The following C#-faithful rules are **intentionally not implemented** by the change that lands this ADR. They are listed so future contributors do not have to re-derive the analysis, and so any later PR that implements one of them can cite this ADR as the source of the design.

- **D1 — Implicit `args` parameter in TLS scope.** C# makes a `string[] args` parameter implicitly available to top-level statements. G# today synthesizes `<Main>$()` with zero parameters, so referring to `args` from TLS is an unresolved-identifier error. The intended target shape is `<Main>$(string[] args)` with `args` in scope inside the synthesized body.

- **D2 — `int`-returning top-level entry point.** C# infers `int` vs `void` for the synthesized entry point based on whether `return <int-expr>;` appears in the TLS. G# today always synthesizes a `void` entry point and silently rejects `return <int>` in TLS context. The intended target is to widen the synthesized signature to `int <Main>$(string[] args)` when an integer `return` is observed (matching C#'s inference), and to expose the process exit code through the same channel.

- **D3 — `async` top-level entry point.** C# allows `await` inside TLS and rewrites the synthesized entry point as `async Task` or `async Task<int>` accordingly. G#'s `async` lowering and Task-returning entry-point machinery already exist (ADR-0023); the missing piece is the binder rule that promotes the synthesized signature when `await` is observed in TLS.

- **D4 — Diagnostic for TLS in a library (`OutputType=Library`) compilation.** C# reports CS8805 when TLS appear in a project that produces a library. G# today emits a dead entry point inside the `.dll`, which the runtime ignores. The intended target is a binder-level error (or, if surfaced from the SDK, an MSBuild-level error) that asks the developer to either switch to `OutputType=Exe` or remove the TLS.

- **D5 — TLS must precede type declarations within the same file.** C# requires TLS to appear before any `namespace` or type declaration in the same file. G#'s parser currently allows free interleaving. The intended target is a parser-level diagnostic enforcing TLS-then-declarations ordering, which makes file structure self-documenting and matches the C# mental model.

- **D6 — Demote GS0166 from error to warning that prefers TLS.** C# reports CS7022 as a warning when both TLS and explicit `Main` are present and silently prefers TLS as the entry point. G# today rejects this combination outright (GS0166 = error). The intended target is to mirror C# (warning, TLS wins) once the rest of the GS0166-Deferred items above are in place, so that "prefer TLS" is unambiguous.

- **D7 — Canonical, caller-independent statement ordering across files.** Today the binder concatenates per-file TLS in caller-supplied order (rule §2 above). A future change could sort contributing files by ordinal source path (or another stable canonical key) so cross-file TLS ordering is identical regardless of how the build tool populates `@(Compile)`. That would make side-effect order, debugger stepping order, and emitter golden output reproducible across rebuilds, filesystems, and tools.

These seven items are recorded as ADR consequences, not as TODO comments in code. Anyone implementing one of them should follow up with a PR that updates this ADR's §Status of each item from "Deferred" to "Accepted" with a citation to the implementing commit.

## Consequences

**Positive:**

- One authoritative document answers "what does TLS do when I add a second `.gs` file?" — replacing today's three partially-overlapping sources.
- The GS0165 message text becomes truthful, reducing developer confusion when the diagnostic fires.
- Deterministic cross-file ordering is pinned down, making same-package multi-file TLS programs reproducible.
- Future TLS work has a single reference point for "what does C# do?" with explicit Accepted/Deferred markers.

**Negative:**

- Six known gaps vs C# remain (D1–D6), plus an internal-consistency gap (D7). Developers migrating from C# may stumble on missing `args`, missing `int` return, and the error-vs-warning behavior when both TLS and `Main` exist. The gap is now visible rather than hidden, but the gap itself is still there.

**Neutral:**

- No behavioral change to the binder, parser, or emitter beyond the one-line GS0165 message-text edit. Existing programs continue to compile and run exactly as before.
- ADR-0028's narrowing of the TLS rule to "one package" is preserved unchanged; this ADR reaffirms it and elevates it to the canonical phrasing.

### Gap matrix vs C# 9 top-level statements

| Area | C# behavior | G# today | This ADR |
| --- | --- | --- | --- |
| TLS across files in same package | Statements concatenate in file order | Allowed; binder concatenates in caller-supplied order | Accepted; canonical sort recorded as D7 |
| TLS spanning multiple packages | N/A (C# has no "package") | Error GS0165 | Accepted; message text corrected |
| TLS + explicit `Main` | Warning CS7022, TLS wins | Error GS0166 | Accepted as-is; revisit recorded as D6 |
| Implicit `args` | `string[] args` in scope | No `args` available | D1 — Deferred |
| `int` return from TLS | Inferred → `int <Main>$` | `return <int>` rejected | D2 — Deferred |
| `await` in TLS | Lifted to `async Task[<int>]` | Not specified | D3 — Deferred |
| TLS in `OutputType=Library` | Error CS8805 | Silently emits dead entry point | D4 — Deferred |
| TLS ordering inside one file | TLS must precede type decls | Parser allows interleaving | D5 — Deferred |
| Synthesized entry-point name | `<Main>$` reserved | `<Main>$` reserved | Accepted (matches C#) |
| TLS-declared locals visibility | Method-scoped, not exported | Method-scoped, not exported | Accepted (matches C#) |

## Alternatives considered

- **Inline the TLS contract into `design/Gsharp-design-v0.1.md` instead of an ADR.** Rejected: the design doc is the v0.1 historical record (see ADR-0010 on its role); landing decisions there mixes "what we shipped first" with "what we have decided since." ADRs are the right home for evolving decisions, and ADR-0028 already set the precedent for refining the v0.1 entry-point story this way.

- **Forbid multi-file TLS entirely and require all TLS to live in one file.** Considered for simplicity. Rejected: ADR-0028's multi-package model already allows the entry-point package to span multiple files for non-TLS members, and arbitrarily forbidding multi-file TLS would force developers to merge files for unrelated reasons. Deterministic ordering (rule §2) gives us reproducibility without that ergonomic cost.

- **Implement all six C#-faithful rules (D1–D6) in the same PR that lands the ADR.** Rejected by the request author: each of D1–D6 is a non-trivial behavior change with its own test surface; bundling them with the ADR would obscure the design decision under implementation noise. They are deferred and can land independently, each citing this ADR.

- **Make GS0166 a warning today (matching C#'s CS7022) without implementing D1–D5 first.** Rejected: prefer-TLS-silently is only ergonomic if TLS can actually express everything `Main` can (args, int return, async). Until D1/D2/D3 land, demoting GS0166 would silently swallow user intent and produce a less-functional program than the explicit `Main` they wrote. The hard error is the more developer-friendly behavior in the interim.

## Acceptance

- This ADR file exists at `docs/adr/0066-top-level-statement-mechanics.md`.
- `design/Gsharp-design-v0.1.md` §"Entry-point synthesis rules" cross-references this ADR as the authoritative source.
- `docs/diagnostics.md`'s GS0165 row matches the corrected message text in `DiagnosticBag.cs`.
- `test/Core.Tests/CodeAnalysis/Binding/BinderEntryPointTests.cs` contains positive and negative tests for each Accepted rule (§§1–6 above) — including the deterministic-ordering rule (§2), the conflict rule (§4) across same-file, cross-file, and cross-package shapes, and the three-package variant of the multi-package rule (§5).
- `test/Compiler.Tests/Emit/TopLevelStatementEmitTests.cs` provides one end-to-end emit smoke test confirming a TLS-only program compiles, IL-verifies, and runs.
- Full test suite (`dotnet test GSharp.sln --no-restore --nologo`) stays green.
