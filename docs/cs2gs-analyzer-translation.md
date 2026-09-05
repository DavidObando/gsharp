# cs2gs: translating Roslyn analyzer projects to G# analyzers

Status: implemented through the map/idiom layer (2026-08-19). The real
GSA0001–GSA0005 sources translate and bind against `GSharp.Core`, with
shape-changing adaptations reported as `CS2GS-ANALYZER-SHAPE`
(`Cs2Gs.Tests/Adr0169AnalyzerTranslationTests`).

The two verification follow-ups are implemented (2026-08-19, second pass):
- **Parity harness** (`Cs2Gs.Tests/Adr0169AnalyzerParityTests`): the real
  Roslyn GSA0001 over a C# corpus vs. the cs2gs-translated GSA0001 —
  compiled by the real G# compiler and loaded through `GSharpAnalyzerHost` —
  over the translated corpus, diffing on (id, per-file ordinal). It has
  already earned its keep twice: it caught the member-access-only detection
  gap (fixed by extending GSA0001 to bare reads) and the assignment-LHS
  false-lowering being wrong for G#'s embedded-target write nodes (fixed by
  the write-node parent-kind idiom).
- **Snippet translator** (`SnippetTranslator`, in Cs2Gs.ProjectLoading):
  translates marked C# test snippets to G# with `[|…|]` markers re-placed by
  ordered exact-text match; unplaceable markers surface as
  `CS2GS-ANALYZER-SNIPPET`. Re-placed markers denote expected-diagnostic
  REGIONS (G# node spans differ), verified end-to-end in
  `Adr0169SnippetTranslationTests`.

### GSA0005 reviewed adaptations

GSA0005 uses narrow, source-shape-specific rewrites rather than a Roslyn
compatibility facade. `TypeSymbol.GetConstructors()` exposes constructor
callables while keeping constructors outside `GetMembers()`. The translator
combines those callables with static factory functions and adapts constructor
kind tests, optional parameters, return types, base types, initializer
wrappers, direct construction calls, static factory calls, base delegation,
switch cases, property-pattern fields, nested designations, and final
qualified/generic type-name extraction to their native G# shapes. Every
shape-changing rewrite remains guarded and reports
`CS2GS-ANALYZER-SHAPE`.

Consumer project references now retain the migrated analyzer project and
rewrite `OutputItemType="Analyzer"` to
`OutputItemType="GsharpCodeAnalyzer"`. Migrated analyzer projects reference
the compiler host's `GSharp.Core.dll` directly, avoiding a project cycle when
the translated analyzer is used while building Core itself.
Companion to [ADR-0169](adr/0169-gsharp-analyzer-framework.md), which defines
the G#-side analyzer framework this document targets. First migration target:
`src/Analyzers/InternalAnalyzers` (GSA0001–GSA0005) and its test project, which
must keep guarding the compiler once `src/Core` self-migrates to G#.

## The core insight

An analyzer project is the one place where cs2gs's normal rule — third-party
CLR APIs pass through untouched — is wrong. Two rewrites must happen at once:

1. **Host-API rewrite.** `Microsoft.CodeAnalysis.*` types and members become
   their `GSharp.Core.CodeAnalysis.Analyzers` equivalents. Because ADR-0169
   mirrors Roslyn's shape, this is mostly mechanical.
2. **Analyzed-language rewrite.** The analyzer's detection logic is written
   against C# syntax and semantics, but its translated self must detect the
   same smell in the *translated G# code*. Wherever cs2gs changes the shape of
   code during translation (assignment-as-statement, auto-properties to
   fields, `typeof` forms…), the analyzer's pattern-match must change shape
   too. This is only partially mechanical, so every non-mechanical spot must
   be loud.

Every mapping rule therefore carries a fidelity class:

- **Exact** — mechanical rewrite.
- **Adapted** — mapped, but detection semantics shifted; emits the new
  `CS2GS-ANALYZER-SHAPE` warning ("detection logic adapted because C# and G#
  shapes diverge here; human review required") carrying the rule's note.
- **Missing** — no G# equivalent; `CS2GS-GAP` / `CS2GS-UNSUPPORTED` via the
  existing `TranslationContext.ReportUnsupported` choke point. Never silent.

## Detection

Project-level detection, symbol-gated application:

- New `Cs2Gs.Translator/Analyzers/AnalyzerProjectDetector.cs`: a project is an
  analyzer project iff the compilation resolves
  `Microsoft.CodeAnalysis.Diagnostics.DiagnosticAnalyzer` via
  `GetTypeByMetadataName` **and** at least one source type derives from it.
  Sets `TranslationContext.AnalyzerTranslationMode`.
- csproj heuristics (`EnforceExtendedAnalyzerRules`, `IsRoslynComponent`,
  `Microsoft.CodeAnalysis.CSharp` package) are used only by the project
  transformer, which has no compilation; the semantic check is authoritative
  for the translator.
- Individual rewrites still gate per-use on "does this symbol live in a
  `Microsoft.CodeAnalysis*` assembly" — the established
  `TryTranslateGeneratedRegex`-style guard — so ordinary code in the same
  project translates normally, and analyzer types in mixed projects are still
  caught when the flag is off.

## Mapping architecture

- `Cs2Gs.Translator/CSharpToGSharpTranslator.Analyzers.cs` — new partial with
  `TryTranslateAnalyzerType` / `TryTranslateAnalyzerMemberAccess` /
  `TryTranslateAnalyzerInvocation` guards hooked into the existing type,
  member-access, and invocation paths (the `Members.cs:281` template).
- `Cs2Gs.Translator/Analyzers/RoslynAnalyzerApiMap.cs` — the declarative
  table, four sub-tables:
  - `TypeMap`: full metadata name → G# type (+ fidelity + note);
  - `MemberMap`: `(declaring type, member)` → target member or an
    idiom-rewriter delegate for multi-node idioms;
  - `SyntaxKindMap`: C# `SyntaxKind` → 0..n G# `SyntaxKind`s;
  - `OperationKindMap` / `SymbolKindMap`: `OperationKind` → `BoundNodeKind`,
    Roslyn `SymbolKind` → G# `SymbolKind`. `OperationKindDispatch` is the
    one-to-many half of the first (#3920): a REGISTRATION must name every G#
    bound-node kind the operation reaches, while a bare kind READ still maps
    to the single kind it names.
- Composition with `CSharpTypeMapper` is a single probe: if a symbol's
  containing assembly is a `Microsoft.CodeAnalysis` assembly, consult the map;
  on a miss, report a gap instead of falling into CLR-import passthrough.
- `Cs2Gs.Translator/Coverage/RoslynAnalyzerSurface.cs` — a new coverage axis
  parallel to `Coverage/RoslynSurface.cs`: the Microsoft.CodeAnalysis API
  surface partitioned into Mapped / Adapted / UnsupportedByDesign, kept in
  lockstep with the map by coverage tests. Unregistered use → `CS2GS-GAP`.
- **Map freshness (REQ-15):** a cs2gs test reflects over the real
  `GSharp.Core` assembly and asserts every G#-side name in the map exists, so
  the map can never silently rot against the framework.

## SyntaxKind and node-shape mapping

Cardinality behavior for `SyntaxKindMap` entries:

- **1:1** — rewrite the enum literal (Exact).
- **1:N** — the `RegisterSyntaxNodeAction` call registers *all* target kinds
  against the same translated callback; callback-side casts become a match
  over the target node types (Adapted, flagged).
- **N:1** — allowed silently for the literal itself; if the analyzer
  distinguishes the merged kinds elsewhere (`IsKind` on a collapsed sibling),
  that check degenerates and is flagged.
- **1:0** — `CS2GS-GAP`; the registration and callback are still emitted so
  nothing silently disappears.

Node-property accesses map through `MemberMap` keyed on the Roslyn syntax type
(e.g. `(ElementAccessExpressionSyntax, Expression)` → G# index expression
target).

### Representative rules (drawn from GSA0001–GSA0005)

REQ-n marks requirements on the ADR-0169 framework, all satisfied by its
initial implementation.

| # | Roslyn construct | G# target | Fidelity |
|---|------------------|-----------|----------|
| 1 | `DiagnosticAnalyzer` | `GSharpDiagnosticAnalyzer` | Exact |
| 2 | `[DiagnosticAnalyzer(LanguageNames.CSharp)]` | `[GSharpDiagnosticAnalyzer]`, language arg dropped | Exact |
| 3 | `Diagnostic.Create(desc, node.GetLocation(), …)` | `Diagnostic.Create(desc, node.Location, …)` (REQ-1) | Exact |
| 4 | `ConfigureGeneratedCodeAnalysis` / `EnableConcurrentExecution` | same-named shims (REQ-2) | Exact |
| 5 | `SyntaxKind.ElementAccessExpression` | G# index-expression kind (REQ-3) | Exact — GSA0001 |
| 6 | `ElementAccessExpressionSyntax.Expression` | index-expression target property (REQ-4) | Exact — GSA0001 |
| 7 | `MemberAccessExpressionSyntax.Name.Identifier.ValueText` | member-name token text idiom (REQ-5) | Exact |
| 8 | `expr.Parent is AssignmentExpressionSyntax a && a.Left == expr` | assignment-statement target check; paren-walk collapses | **Adapted** — canonical shape-divergence case (GSA0001 write-exemption) |
| 9 | `SyntaxKind.MethodDeclaration` / `MethodDeclarationSyntax` | function-declaration kind/node (REQ-6) | Adapted (N:1 with local functions/accessors noted) — GSA0005 |
| 10 | `OperationKind.BinaryOperator`, `IBinaryOperation.{LeftOperand,RightOperand,OperatorKind}` | `RegisterBoundNodeAction(cb, BoundNodeKind.BinaryExpression)`, bound binary members (REQ-7) | Exact — GSA0002 |
| 11 | `OperationKind.Invocation`, `IInvocationOperation.TargetMethod` | call-expression bound node, `FunctionSymbol` | Exact — GSA0002 |
| 12 | `IConversionOperation` unwrap loop | bound conversion operand unwrap | **Adapted** — G# inserts different implicit conversions — GSA0002 |
| 13 | `OperationKind.TypeOf` pattern | re-targeted at whatever form cs2gs's own `typeof` translation produces | **Adapted-or-Missing** — the deepest case: the *pattern itself* must follow cs2gs's rewrite of the analyzed code — GSA0002 |
| 14 | `SymbolKind.Field/Property`, `IFieldSymbol`, `IPropertySymbol` | G# `SymbolKind.Field/Property`, `FieldSymbol`, `PropertySymbol` | Exact, with an Adapted note: auto-property→field translation can shrink the Property action's population — GSA0003/0004 |
| 15 | `INamedTypeSymbol.ConstructedFrom`, `TypeArguments` | G# generic-instantiation symbol API (REQ-8) | Exact — GSA0003/0004 |
| 16 | `SymbolEqualityComparer.Default` | G# equivalent (REQ-9) | Exact — GSA0004 |
| 17 | `ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)` | canonical fully-qualified display (REQ-10); string comparisons against rendered output re-checked | Adapted |
| 18 | `SemanticModel.GetDeclaredSymbol` / `GetSymbolInfo(...).Symbol` | G# `SemanticModel` equivalents (REQ-11) | Exact — GSA0005 |
| 19 | `IMethodSymbol.OverriddenMethod` chain | `FunctionSymbol` override chain (REQ-12) | Exact — GSA0005 |
| 20 | `ISymbol.DeclaringSyntaxReferences` → `GetSyntax()` | `Symbol.DeclaringSyntaxNodes` (REQ-13) | Exact — GSA0005 |
| 21 | String literals naming analyzed-code identifiers (`"StructFieldDefs"`, namespace strings) | kept verbatim; literals flowing into name-comparison positions get an info-level shape note ("verify identifier survives migration unchanged") | Adapted |
| 22 | `CSharpCompilation.Create` / `WithAnalyzers` / `GetAnalyzerDiagnosticsAsync` (tests) | G# `Compilation` + `GSharpAnalyzerDriver` / verifier surface (REQ-14) | Exact |

REQ-16: the analyzer host TFM is net10 (in-proc in gsc), so translated analyzer
projects retarget `netstandard2.0` → `net10.0`. REQ-17: the SDK defines the
`GsharpCodeAnalyzer` output-item contract with Analyzer-shaped metadata so the
consumer rewrite is a pure value substitution.

## Test-harness and snippet translation

Status (2026-09-01, issues #3686 / #3778): the **harness half is implemented**
(#3777) and the **snippet half is dispatched** (#3778) — see "M5 status" below
for what is still open.

The original plan here — "`AnalyzerTestHelper.cs` is ordinary C# and translates
normally, rules 3/22 rewrite the Roslyn calls" — did not survive contact with
the harness body, and rule 22 is now implemented differently than that line
describes. The harness does not merely *call* Roslyn APIs; it builds a
`CSharpCompilation` over metadata references pulled from
`TRUSTED_PLATFORM_ASSEMBLIES` and drives Roslyn's analyzer driver. The G#
verifier takes **no metadata references at all**, so the faithful translation
of `GetReferences()` is deletion, not mapping — and translating the remaining
calls one by one would reimplement, inside the migrated test project, the
marker-stripping and assertion logic `GSharpAnalyzerVerifier` already owns.

Implemented instead (`CSharpToGSharpTranslator.Analyzers.cs`,
`IsAnalyzerHarnessEntry` / `TryBuildAnalyzerHarnessBody`): the harness entry
point — a static method taking an analyzer and a source string — keeps its
**signature**, so no call site changes, and its **body** becomes a single
delegation to
`GSharp.CodeAnalysis.Analyzers.Testing.GSharpAnalyzerVerifier.VerifyAnalyzer`.
Private members that existed only to serve it are dropped. The substitution is
reported as `CS2GS-ANALYZER-SHAPE`, never silent.

That required one addition to the framework: ADR-0169 shipped
`GSharpAnalyzerVerifier<TAnalyzer>` (static, generic, `new()`-constrained),
but a migrated harness holds an analyzer **value** and has no type parameter to
bind, so an instance-based overload
`GSharpAnalyzerVerifier.VerifyAnalyzer(analyzer, markedSource, ids…)` was added
alongside it. Hand-written G# analyzer tests keep using the generic form.

Detection is per project on both halves: `AnalyzerProjectDetector` gained
`IsAnalyzerTestProject` — a project that **declares an analyzer test harness**
(`IsAnalyzerTestHarnessEntry`: a static method taking a `DiagnosticAnalyzer` and
a source `string`) **and** instantiates an analyzer declared in a referenced,
non-Roslyn assembly — and `GSharpProjectTransformer` recognizes the
structural counterpart (a `ProjectReference` to an analyzer project that is not
an `OutputItemType="Analyzer"` consumer reference) to inject the two assemblies
the migrated tests bind — `GSharp.Core` and the verifier — both copied to the
test output, because a test assembly is loaded by the test host rather than by
gsc.

Why the harness, and not instantiation alone (issue #3789): analyzer mode maps
a project's **whole** `Microsoft.CodeAnalysis` surface, so it may only claim a
project whose Roslyn use it can map. Constructing an analyzer is not enough
evidence of that — `tools/cs2gs/Cs2Gs.Tests` runs the real GSA analyzers as a
library to diff them against their translated counterparts, and its other
~256 Roslyn uses are cs2gs machinery (`MetadataReference`, `CSharpCompilation`)
that has, and should have, no analyzer-API mapping; claiming it turned a
14-error compile wall into 98 translate gaps. The harness is the one member
analyzer mode rewrites for a test project, so its presence is exactly the
condition under which analyzer mode has something to offer, and the detector
and the rewrite share one predicate. Rejected alternatives: keying on a
reference to Roslyn's analyzer-testing package (the repo's own harness is
hand-rolled and does not bind it, so the signal is a dead `PackageReference`
that a cleanup would silently remove — and both projects reference the *G#*
verifier, so that variant does not discriminate at all); a proportion
threshold on analyzer-related surface (no defensible cut point, and any
project above it still gaps on the remainder); and per-file claiming (it does
not fix the case — `Cs2Gs.Tests`' analyzer instantiation sits in a file that
is itself full of unmappable cs2gs machinery — while breaking the working
case, since `AnalyzerTestHelper.cs` instantiates no analyzer and would stop
being claimed).

The other half is the **embedded C# snippets** — raw strings of analyzed code
inside tests, which the migrated harness now hands to a verifier that compiles
**G#**. `SnippetTranslator` (nested cs2gs invocation at translation time, not
manual porting) always existed; issue #3778 is what **dispatches** it.

**The dispatch rule.** An expression is a snippet exactly when it is a
compile-time constant string that *flows into the source parameter of an
analyzer test harness entry point* — either as the initializer of a local later
passed there, or directly as that argument
(`CSharpToGSharpTranslator.AnalyzerSnippets.cs`). The conjunction is
load-bearing in both directions:

- "a `const string` local" alone would rewrite every constant in the project;
- "a string containing `[|…|]`" alone would miss the nine of sixteen snippets in
  `test/InternalAnalyzers.Tests` that assert *no* diagnostic and so carry no
  marker, and would fire on any unrelated string containing the digraph.

The harness parameter is the only signal that says "this string will be
compiled as source", which is what makes translating it correct and leaving it
alone wrong. Neither shape the ADR originally assumed (a literal argument at the
call site) occurs in the real tests: every snippet arrives through a local, and
several are **composed** (`Model + """…"""` with a shared `const string` model).
Neither operand of a composition compiles on its own, so the guard fires only on
the *whole initializer* and takes its text from Roslyn's constant folding — the
migrated test therefore carries the folded, translated whole and loses the
shared-model factoring. That is the accepted trade.

**Marker preservation.** Markers are re-placed by occurrence ordinal: the Nth
occurrence of a marked text in the C# is the Nth occurrence of that text in the
G#. The earlier "search forward from the previous marker" rule silently
mis-placed a marker whose text also occurred *earlier* in the unit — which is
precisely what a composed snippet produces, since the shared model declares the
member the per-test class overrides. A marked text that does not survive
translation verbatim is **dropped and reported** as `CS2GS-ANALYZER-SNIPPET`
(printed by `TranslateStage`, not merely recorded); the migrated test then fails
on a marker/id count mismatch rather than asserting a wrong span.

**Markers are regions.** `GSharpAnalyzerVerifier` asserts the produced
diagnostic's span is *contained in* the marked region, not that it starts at the
marker. A hand-written G# test brackets exactly the construct it expects, so its
diagnostic is span-equal and nothing relaxes; what the region admits is the
cross-language case, where a translated marker keeps the C# extent and G#'s node
shapes differ (its index node is narrower than C#'s element access). Containment
in *both* directions keeps the assertion falsifiable — a marker narrower than
the diagnostic, or on a neighbouring construct, still fails.

**One package per unit — several units per snippet (issue #3794).** A G#
compilation unit declares a single `package`, so a C# snippet spanning several
namespaces has no one-unit rendering: collapsing it into the first package moved
every declaration, and the namespace-scoped rules then judged the wrong ones —
GSA0004 found *nothing* in a snippet whose C# original reports four times, and
GSA0003 reported a false positive on a cache the C# exempts only because of its
namespace. `SnippetTranslator` therefore emits **one unit per declared package,
in declaration order**, joined by the `// ---8<--- cs2gs:next-compilation-unit
---` line, and `GSharpAnalyzerVerifier` splits on that line and compiles the
units **together** in one compilation. The harness signature is unchanged — it
still takes one source string, which is what a translated Roslyn harness has in
hand.

Markers and diagnostics are then compared **per unit**: a diagnostic belongs to
the unit whose file name it carries, ordering is (unit, span start), and a
diagnostic reported in the wrong unit fails with that named cause. A source
containing no separator is one unit, so every hand-written G# analyzer test is
untouched.

**The one lexical rename (issue #3797).** C#'s predefined type keywords become
G#'s width-bearing primitive names (ADR-0115 §B.12), which is the only rename
translation applies *inside* expression text — so the marker
`[|typeof(int) != type|]` could not be placed on the printed
`typeof(int32) != type` and was dropped. Placement now retries against the
marker re-spelled from its own `PredefinedTypeSyntax` nodes (never by text
substitution, so an identifier that merely contains the letters is untouched),
with the ordinal measured in the equally re-spelled source so a repeated marker
still lands on the right occurrence. A marker that still cannot be placed stays
loud.

## Project and consumer transform

`Cs2Gs.Pipeline/GSharpProjectTransformer.cs` gains an analyzer branch
(triggered by the csproj heuristics):

- `TargetFramework` `netstandard2.0` → `net10.0` (REQ-16 rationale: the G#
  host is gsc, net10; netstandard2.0's VS/old-host loading rationale does not
  exist for G#).
- Drop the `Microsoft.CodeAnalysis.CSharp` `PackageReference`; add a reference
  to `GSharp.Core` (project or package form per repo context),
  `PrivateAssets` preserved.
- Drop `EnforceExtendedAnalyzerRules` and `NoWarn RS1036`; keep
  `AnalyzerReleases.*.md` as inert content (IDs are unchanged).
- Consumer side: `ProjectReference` metadata
  `OutputItemType="Analyzer" ReferenceOutputAssembly="false"` →
  `OutputItemType="GsharpCodeAnalyzer" ReferenceOutputAssembly="false"`
  (the exact rewrite `src/Core/Core.csproj` needs).

## Parity verification

Two layers; test-level is the primary signal:

- **Test-level**: the translated `InternalAnalyzers.Tests` run under the G#
  verifier, each diagnostic contained in its translated `[|...|]` region
  (issue #3778 — the region, not an exact start, is what survives translation).
- **Corpus-level**: a new `Cs2Gs.Pipeline/AnalyzerParityStage.cs` (sibling of
  TestParity) runs the original Roslyn analyzers over the C# corpus and the
  compiled G# analyzers over the translated corpus, diffing diagnostic
  multisets keyed `(id, path with .cs→.gs, ordinal-within-file)` — line/column
  deliberately excluded (translation shifts them), anchor-token text as
  tie-breaker. Mismatches fail with a per-file report; a reviewed allowlist
  covers accepted Adapted-fidelity divergences. This catches the worst failure
  mode: an Adapted rewrite that type-checks but detects nothing.

## Phasing (implementation effort, post-ADR-0169)

Order: GSA0001 → GSA0003 → GSA0004 → GSA0002 → GSA0005; harness and parity last.

- **M0 Scaffolding** — detector, mode flag, `RoslynAnalyzerSurface` axis,
  `CS2GS-ANALYZER-SHAPE` id, transformer analyzer branch + consumer rewrite.
  Tests: minimal analyzer fixture; gsproj golden; unmapped-API → `CS2GS-GAP`
  test; coverage-consistency test.
- **M1 Syntax analyzers (GSA0001)** — rules 1–8. Tests: translation tests
  (`Translate()` + `AssertBinds`), goldens of translated GSA0001, exactly-one
  `CS2GS-ANALYZER-SHAPE` assertion for rule 8.
- **M2 Symbol actions (GSA0003, GSA0004)** — rules 14–17; REQ-15
  map-freshness reflection test lands here.
- **M3 Bound-node actions (GSA0002)** — rules 10–13 + `OperationKindMap`.
- **M4 Semantic-model idioms (GSA0005)** — rules 9, 18–20 (hardest, 428
  lines).
- **M5 Test project + snippets** — `SnippetTranslator`, CodeModel `Origin`
  provenance, `CS2GS-ANALYZER-SNIPPET`, goldens of all translated GSA tests.

  **M5 status (2026-09-01, issue #3686).** Done: test-project detection,
  harness rewrite, the instance-based verifier entry point, and the project
  transform. Measured on `test/InternalAnalyzers.Tests`, the app was walled at
  16 `GS0154` errors (3 fingerprints) and now translates, **compiles and
  ilverifies clean**.

  **M5 second half (2026-09-01, issue #3778).** `SnippetTranslator` is now
  dispatched: the constant string reaching the harness's source parameter is
  translated to G#, markers and all. Measured on the same 2-app migration,
  test-parity went **16 failing → 6 failing / 10 passing** (translate, compile
  and ILVerify stay PASS). Each of the six has a stated, printed cause:

  - **2** — a snippet spanning several namespaces collapses into one G#
    package, so `GSA0003`/`GSA0004` judge the wrong declarations. Reported as
    `CS2GS-ANALYZER-SNIPPET`. Note this also makes one *negative* test pass
    vacuously, for the same reason.
  - **2** — `GSA0005` (rewriter clone preservation) fires on the C# but not on
    the translated G# shapes. **Fixed by issue #3795**, see below.
  - **1** — the marked text `typeof(int) != type` becomes `typeof(int32) !=
    type` in G#, so the marker cannot be re-placed by text; dropped and
    reported.
  - **1** — the migrated `GSA0003` reports on a G# field symbol whose
    `Location` is empty, so the verifier cannot check the marker. It now names
    that cause instead of throwing a `NullReferenceException`.

  **GSA0005 detection parity (2026-09-02, issue #3795).** The two `GSA0005`
  failures above were a FRAMEWORK gap, not a translation one: `Symbol.
  ContainingType` — the ADR-0169 counterpart of Roslyn's
  `ISymbol.ContainingType` — was filled in only on the analyzer driver's
  SYMBOL-action path, which early-returns when no symbol action is registered.
  GSA0005 is a syntax-node analyzer; it reaches its member symbols through
  `SemanticModel.GetDeclaredSymbol`, saw `null`, and returned before its
  base-type walk, so it reported **nothing at all** — the failure mode that
  passes every negative test. Anchoring now runs while the semantic model
  indexes declared symbols (`SymbolContainment.AnchorMembers`), so both
  surfaces agree. Every other adapted shape GSA0005 relies on (the
  `MethodKind.Constructor`/`Ordinary` → `.ctor` rewrite, the
  `GetMembers().Concat(GetConstructors())` augmentation, `OverriddenMethod`,
  `DeclaringSyntaxNodes`) was already correct.

  Same 2-app migration: test-parity **6 failing / 10 passing → 4 failing /
  12 passing** (translate, compile, ILVerify stay PASS on both sides). The four
  that remain are #3794 (×2, namespace collapse), #3796 and #3797 — the same
  tests, failing the same way.

  The corpus parity harness now covers GSA0005 as well as GSA0001
  (`Adr0169Gsa0005ParityTests`), which is what stops a rule that quietly stops
  firing from passing again: its negatives share one parameterised path with
  positives that demand a diagnostic.

  **The last four (2026-09-04, issues #3794 / #3797).** Re-measured on the
  whole-repository gate, `test/InternalAnalyzers.Tests` was **3 failing / 15
  passing of 18**, not four: #3796 had already been cleared by #3847's field
  source locations. The three that remained were two causes — and clearing
  them exposed three more, every one of them a FRAMEWORK gap rather than a
  translation one, in the same family as #3795:

  1. **Package collapse (#3794, ×2).** Fixed by emitting one compilation unit
     per declared package and teaching the verifier to compile them together
     (see §Test-harness above).
  2. **Marker rename (#3797, ×1).** Fixed by retrying placement against the
     predefined-type re-spelling.
  3. **`ImportedTypeSymbol.ConstructedTypeArguments` was CLR-derived**, and a
     generic over a same-compilation user type is type-erased to
     `Dictionary<object, object>` — so GSA0004 saw `System.Object` for every
     cache key and matched nothing. It now prefers the symbolic arguments.
  4. **`TupleTypeSymbol` did not implement `IsTupleType`/`TupleElements`**, so
     a tuple key looked like a type with no components.
  5. **`IArrayTypeSymbol` mapped to `ArrayTypeSymbol`** — G#'s fixed-length
     `[N]T`, a shape cs2gs never emits. C# `T[]` translates to the slice `[]T`,
     so the map now names `SliceTypeSymbol`.
  6. **`PropertySymbol.Location` spanned the whole declaration**, swallowing
     the marker; it now points at the identifier, as #3847 already did for
     fields.

  Note what (3)–(5) have in common: each made a structural walk return `false`
  early, and each therefore presented as *silence*. That is why the regression
  tests (`Issue3794AnalyzerSnippetPackageSplitTests`) put the positive and
  negative snippets of GSA0003 **and** GSA0004 on one parameterised path that
  translates the real analyzer, compiles it with the real G# compiler, loads it,
  and runs it through the real verifier: a rule that stops reporting fails the
  positives instead of passing the negatives.

  Whole-repository gate on the same tree: `test/InternalAnalyzers.Tests`
  test-parity **3 failing / 15 passing → 1 failing / 17 passing of 18**
  (translate, compile and ILVerify stay PASS on both sides).

  **The last one (2026-09-05, issue #3920).** Clearing #3797 is what exposed it:
  with the third marker finally placed,
  `ReflectionTypeComparisonAnalyzerTests.ReportsTypeofReferenceComparisonsInCompilerMetadataNamespaces`
  got past the marker/id count check and GSA0002 then reported **nothing**.

  One Roslyn operation kind is SEVERAL G# bound nodes. `a == b` binds to
  `BoundBinaryExpression` for a built-in operator and to
  `BoundClrBinaryOperatorExpression` when it resolves to an `op_Equality`
  method; a call binds to `BoundCallExpression`,
  `BoundImportedCallExpression`, or `BoundImportedInstanceCallExpression` by
  callee provenance. The split is a codegen distinction, not a
  program-meaning one — Roslyn models each pair/triple as one operation — but
  naming a single node in the map meant the migrated GSA0002 was dispatched
  **zero times** over reflection-`Type` comparisons, which are imported by
  construction. The rule existed only for code it could not see.

  Fixed on both sides of the boundary:

  1. **Framework (`src/Core`).** Two analyzer-facing abstract bases,
     `BoundBinaryOperationExpression` (`Left`, `Right`, `BinaryOperatorKind`)
     and `BoundCallOperationExpression` (`CalledFunction`, `Arguments`), now
     span the provenance-split nodes. `BoundNodeKind` values, lowering and
     emit are untouched — the bases add a shared *shape*, not a new node.
     `Symbol.ContainingType` also stopped depending on having been anchored:
     a method that knows its own declaring type (a `FunctionSymbol`'s
     receiver/owner, an `ImportedFunctionSymbol`'s metadata declaring type)
     now says so, because nothing anchors imported symbols and
     `TargetMethod.ContainingType` read null for every call into metadata.
  2. **Translation (`cs2gs`).** `RegisterOperationAction` expands to a
     `RegisterBoundNodeAction` naming EVERY bound-node kind the operation
     reaches (`RoslynAnalyzerApiMap.OperationKindDispatch`), the two
     `IOperation` map entries name the shared bases, `TargetMethod` maps to
     the `Symbol`-typed `CalledFunction`, and `IBinaryOperation.OperatorKind`
     lowers to `BinaryOperatorKind` rather than `Op.Kind` — `Op` exists only
     on the built-in node.

     `CalledFunction` carries `Name` and `ContainingType` and nothing more,
     because the other two members a rule reaches through `TargetMethod` have
     no honest answer on a callee symbol (PR #3968 review):

     * `ReturnType` is answered by the call NODE. G#'s callee symbol holds the
       DECLARATION's return type, so a constructed generic call reports the
       type parameter — measured on `Identity[int32](1)`: `symbol=T` against
       `node=global::System.Int32`. Roslyn's `TargetMethod` is the
       *constructed* method, so the node's type is the faithful reading, and it
       is right for an imported generic closed over a user-defined type too
       (whose reflected return type is a placeholder) without consulting either
       symbol.
     * `OverriddenMethod` is REJECTED at a call site rather than answered. An
       imported callee has no G# override chain, so any value would be null for
       every call into metadata, and a member analyzers branch on must not
       silently say "no". Reaching it is a `CS2GS-GAP`. The declaring-symbol
       surface is unaffected: `IMethodSymbol.OverriddenMethod` still maps to
       `FunctionSymbol.OverriddenMethod`, which GSA0005 walks — now carrying an
       Adapted note, because a source method overriding an imported CLR base
       records its target in `ExternalOverriddenMethod` and so reads null there
       too.

     The `Invocation` dispatch row names every node a Roslyn invocation
     reaches, not just the static ones: `receiver.Method()` is a
     `BoundUserInstanceCallExpression`, and omitting it meant a migrated
     invocation rule never fired on the most ordinary call in the language.
     Constructor calls are absent by design (Roslyn models those as
     `ObjectCreation`); `BoundIndirectCallExpression` and
     `BoundBaseClassCallExpression`'s property-accessor form stay out because
     neither has a callee symbol to report.

     The dispatch set is deliberately separate from the enum-member rename: a
     bare `OperationKind` READ (`node.Kind == OperationKind.TypeOf`) still
     translates to the one kind it names, because a read tests one node's
     identity while a registration must cover every node that can arrive.

  `Issue3920Gsa0002ImportedOperandDispatchTests` puts the GSA0002 positive and
  both negatives on one executing path — real analyzer, real G# compiler, real
  verifier — so a rule that stops reporting fails the positive instead of
  passing the negatives.

  Whole-repository gate on the same tree: `test/InternalAnalyzers.Tests`
  test-parity **1 failing / 17 passing → 0 failing / 18 passing of 18**.
- **M6 Parity + self-migration** — `AnalyzerParityStage`; extend the
  Issue3347-style self-migration ratchet to translate
  `InternalAnalyzers.csproj` live. Exit criterion: all five translated
  analyzers parity-equal against src/Core vs. translated Core.

Every behavioral test records an ADR-0154 witness of discrimination.

## Risks

- **Framework drift** — mitigated by the REQ-15 reflection test; the REQ list
  above is the contract.
- **Snippet marker provenance** — largest engineering unknown; manual-review
  fallback keeps it non-blocking.
- **Shape-divergence false negatives** — an Adapted rewrite that fires zero
  times; caught by corpus parity.
- **Auto-property→field translation eroding GSA0004's Property action** —
  covered by rule 14's note + parity.
