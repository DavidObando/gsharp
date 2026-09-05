# ADR-0169: G# code analyzer framework

- **Status**: Accepted
- **Date**: 2026-08-18
- **Phase**: Tooling parity
- **Related**: ADR-0027 (Roslyn fork decision), ADR-0145 (source generator host), ADR-0147 (internal source analyzers), ADR-0154 (test oracle strength), `docs/cs2gs-analyzer-translation.md`

## Context

G# has no user-facing code-analyzer system: the only extensible diagnostics today
are the fixed binder passes (definite assignment, exhaustiveness, ref-struct
liveness), and the only analyzer precedent in the repo — `GSharp.InternalAnalyzers`
(ADR-0147) — is a Roslyn suite that analyzes the compiler's **C#** source. Two
pressures make an analyzer framework necessary now:

1. **Self-migration.** The compiler self-migrates to G# via cs2gs. The five GSA
   analyzers (GSA0001–GSA0005) encode hard-won emit-pipeline invariants; once
   `src/Core` is G#, those invariants go unguarded unless functionally
   equivalent analyzers can run over G# source.
2. **Ecosystem parity.** C# projects migrating to G# commonly carry Roslyn
   analyzers. cs2gs can only translate them into something if a G#-side target
   exists.

Constraints that bound the solution space:

- ADR-0027 bars Roslyn from linking into `gsc`; analyzers therefore cannot be
  Roslyn analyzers pointed at G# code.
- The G# object model (syntax trees, `Symbol`s, `BoundNode`s) lives in
  `GSharp.Core` and is not serializable across a process boundary without a
  wire model that would dwarf the framework itself.
- cs2gs translation of existing Roslyn analyzers must be as mechanical as
  possible: every gratuitous shape difference between the G# API and
  `Microsoft.CodeAnalysis.Diagnostics` becomes a hand-written translation rule.
- `gsc /analyzer:` is already taken: per ADR-0145 it names a *source generator*
  assembly and spawns gsgen.

## Decision

Add a Roslyn-shaped analyzer framework to `GSharp.Core`, hosted in-process by
`gsc`, with the following contour:

### API surface (namespace `GSharp.Core.CodeAnalysis.Analyzers`)

The namespace deliberately mirrors `Microsoft.CodeAnalysis.Diagnostics` member
for member wherever the G# compiler model permits, so that cs2gs translation is
predominantly a namespace-and-kind rewrite. It lives inside `GSharp.Core` (no
separate assembly): analyzers must reference Core anyway for `SyntaxNode`,
`Symbol`, and `Compilation`, and Roslyn's own `DiagnosticAnalyzer` living in
`Microsoft.CodeAnalysis.dll` is exactly what makes the `using` rewrite trivial.
(`GSharp.Core.CodeAnalysis.Diagnostics` was unavailable — it is the logging
namespace.)

- `GSharpDiagnosticAnalyzer` — abstract base with
  `SupportedDiagnostics : ImmutableArray<DiagnosticDescriptor>` and
  `Initialize(AnalysisContext)`. Concrete analyzers carry the
  `[GSharpDiagnosticAnalyzer]` class attribute (no language argument — there is
  only one language).
- Contexts named as in Roslyn: `AnalysisContext`,
  `CompilationStartAnalysisContext`, `SyntaxTreeAnalysisContext`,
  `SyntaxNodeAnalysisContext`, `SymbolAnalysisContext`,
  `SemanticModelAnalysisContext`, `CompilationAnalysisContext` — plus
  `BoundNodeAnalysisContext`, the `IOperation` analogue (below).
- Registrations: `RegisterSyntaxNodeAction(action, params SyntaxKind[])`,
  `RegisterSymbolAction(action, params SymbolKind[])`,
  `RegisterBoundNodeAction(action, params BoundNodeKind[])`,
  `RegisterSyntaxTreeAction`, `RegisterSemanticModelAction`,
  `RegisterCompilationStartAction`, `RegisterCompilationAction`.
- Compatibility shims so mechanically translated analyzers compile unchanged:
  `EnableConcurrentExecution()` (recorded no-op — execution is sequential in
  v1) and `ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags)` (the
  driver skips generated (`.g.gs`) trees unless the `Analyze` flag is set).

### `BoundNode` as the `IOperation` analogue

Operation-style analysis registers on `BoundNodeKind` and receives the bound
node, whose `Syntax`, `Type`-carrying members, and symbol references supply
what `IOperation` supplies in Roslyn. Stability posture: **kind-level, not
member-level** — `BoundNodeKind` values are stable once shipped, but bound-node
member shapes may evolve with the language, the same posture Roslyn took with
early `IOperation`.

**One Roslyn operation is several G# bound nodes (issue #3920).** G# splits a
construct by PROVENANCE where Roslyn does not: `a == b` binds to
`BoundBinaryExpression` for a built-in operator and to
`BoundClrBinaryOperatorExpression` when it resolves to an `op_Equality` method,
and a call binds to `BoundCallExpression`, `BoundImportedCallExpression`, or
`BoundImportedInstanceCallExpression` by where the callee lives. The split is a
codegen distinction, so an analyzer must not have to know it: the nodes in each
family derive from a shared analyzer-facing base —
`BoundBinaryOperationExpression` (`Left`, `Right`, `BinaryOperatorKind`) and
`BoundCallOperationExpression` (`CalledFunction`, `Arguments`) — and a rule
registers every `BoundNodeKind` in the family. Registering one is a rule that
silently sees a fraction of the program; it is how the migrated GSA0002
observed none of the reflection-`Type` code it exists to police, since imported
operands are exactly the ones it cares about.

### Supporting infrastructure promoted into Core

- `DiagnosticDescriptor` becomes public and Roslyn-shaped
  (`Id`, `Title`, `MessageFormat`, `Category`, `DefaultSeverity`,
  `IsEnabledByDefault`, `Description`, `HelpLinkUri`), with a compatibility
  constructor preserving the existing 392 compiler descriptors verbatim.
- `Diagnostic` gains `Descriptor`, `AdditionalLocations`, `Properties`, and
  static `Create` factories; `DiagnosticSeverity` gains `Hidden` (Roslyn
  ordering `Hidden < Info < Warning < Error`); `DiagnosticBag` gains a public
  `Report(Diagnostic)`.
- A public `SemanticModel` (`Compilation.GetSemanticModel(SyntaxTree)`) with
  `GetDeclaredSymbol`, `GetSymbolInfo`, `GetTypeInfo`, and `GetBoundNode`,
  extracted from the language server's `SemanticLookup` (which now delegates to
  it). `Symbol` gains `DeclaringSyntaxNodes`.
- A public `GSharpSyntaxWalker` over the cached reflective `GetChildren()`,
  and `SyntaxNode.Parent` (backed by a lazily built per-tree parent index) —
  the Roslyn `Parent` idiom analyzers pattern-match with.

### Execution: `GSharpAnalyzerDriver`, in-process in `gsc`

A driver runs after binding over the same `Compilation` used for emit
(`BoundProgram` is cached, so no duplicate binding): syntax-tree actions and a
kind-bucketed syntax walk per tree, symbol actions over declared symbols, a
bound-tree walk per function body, semantic-model actions, then
compilation-end actions. Sequential, cancellation checked at tree/symbol/body
boundaries.

Hosting is **in-process**: `gsc` loads each analyzer assembly in a collectible
`AssemblyLoadContext` whose `Load` override unifies `GSharp.Core` (and
framework assemblies) to the host's copies. Out-of-process hosting (the gsgen
model) exists because a second pinned Roslyn cannot coexist with MSBuild's and
because gsgen re-parses C# independently; neither reason applies here, and the
object model cannot cross a process boundary. Analyzer crash containment is
per-analyzer, Roslyn-AD0001-style (below), not per-process.

Discovery: exported, non-abstract subclasses of `GSharpDiagnosticAnalyzer`
carrying `[GSharpDiagnosticAnalyzer]`, instantiated via parameterless
constructor. No MEF.

### Command line and MSBuild

- `/gsanalyzer:<path>` (repeatable) — analyzer assemblies. `/analyzer:` keeps
  its ADR-0145 generator meaning.
- `/gsdiag:<ID>=<none|hidden|info|warning|error>` — per-diagnostic severity
  override, applied in the same post-hoc pass as `/nowarn`/`/warnaserror`
  (which work for analyzer IDs unchanged, since they key on ID). `none`
  suppresses; promoting a `Hidden` diagnostic surfaces it. `Hidden`
  diagnostics are never printed unless promoted.
- SDK: a `@(GsharpCodeAnalyzer)` item (package asset folder `analyzers/gsharp/`
  via a `_GsharpResolveCodeAnalyzers` target, or
  `ProjectReference` with `OutputItemType="GsharpCodeAnalyzer"`), forwarded to
  the rsp as `/gsanalyzer:` lines by `BuildTask`. Diagnostics reach MSBuild
  through the existing stdout relogging.

### Host diagnostics (GS9300–GS9319 reserved)

| ID | Severity | Meaning |
|----|----------|---------|
| GS9300 | Warning | Analyzer threw; it is disabled for the rest of the compilation (AD0001 parity). |
| GS9301 | Error | Analyzer assembly failed to load or contains no analyzers. |
| GS9302 | Info | Analyzer exceeded its time budget and was disabled (language-server hosting). |
| GS9303 | Warning | Analyzer built against a mismatched `GSharp.Core` version; load attempted anyway. |
| GS9304 | Warning | Analyzer reported a diagnostic not declared in `SupportedDiagnostics`; the diagnostic is suppressed. |

### Testing surface

A packable `GSharp.CodeAnalysis.Analyzers.Testing` library provides
`GSharpAnalyzerVerifier<TAnalyzer>` using the `[|...|]` span-marker convention
already used by `test/InternalAnalyzers.Tests`, compiling G# source and
running the driver — deliberately shaped like the internal
`AnalyzerTestHelper` so cs2gs can translate existing Roslyn analyzer tests
mechanically.

Amended 2026-09-01 (issue #3686, M5): the same library also exposes the
non-generic `GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, markedSource,
ids…)`. A translated harness holds an analyzer *value* — its parameter is
`GSharpDiagnosticAnalyzer` and the concrete analyzer is chosen at the call
site — so the generic, `new()`-constrained form cannot receive it without
turning an argument into a type argument. Hand-written G# analyzer tests keep
using the generic form; the instance overload exists so the cs2gs harness
rewrite is a body substitution rather than a call-site rewrite.

## Consequences

- The five GSA analyzers gain a migration target: their cs2gs translation is
  specified in `docs/cs2gs-analyzer-translation.md`, and the framework
  satisfies that document's REQ contract (bound-node actions, declaring-syntax
  access, symbol display, semantic-model idioms, marker-based test host).
- `GSharp.Core`'s public surface grows: enriched diagnostics types,
  `SemanticModel`, `GSharpSyntaxWalker`, the analyzer namespace, and de facto
  exposure of `BoundNode`/`BoundNodeKind`. From this ADR on, changes to these
  surfaces follow an additive policy; bound-node stability is kind-level only.
- The language server can host the same driver in its debounced bind phase
  with per-analyzer time budgets (GS9302) — planned as the next milestone, not
  part of the initial change.
- Deferred, in dependency order: `.editorconfig` severity support (the SDK can
  lower `dotnet_diagnostic.*` entries to `/gsdiag:` rsp lines without touching
  `gsc`), concurrent action dispatch (`EnableConcurrentExecution` becomes
  honest), a code-fix framework (the language server's `CodeActionComputer` is
  the natural hook), and out-of-process isolation if in-proc crash containment
  proves insufficient.

## Alternatives considered

- **Author G# analyzers as Roslyn analyzers over a C# projection** (extend the
  gsgen stub projection): rejected — the projection elides bodies, so only
  declaration-level rules could fire, and ADR-0027 keeps Roslyn out of gsc.
- **Separate `GSharp.CodeAnalysis.Analyzers` assembly**: rejected for now — it
  creates a version-skew pair and an `InternalsVisibleTo` wall for the driver
  while buying nothing; type-forwarding keeps the option open later.
- **Out-of-process analyzer host (gsgen model)**: rejected as the default —
  requires a serializable projection of syntax/bound/symbol models far larger
  than the framework, and weakens the semantic surface. Revisit only if
  in-proc containment fails in practice.
- **A G#-specific, non-Roslyn-shaped API** ("design the API we'd want from
  scratch"): rejected — every divergence from Roslyn's shape is a hand-written
  cs2gs adaptation rule and a porting hazard for the GSA suite; parity with a
  proven design is worth more than novelty here.
