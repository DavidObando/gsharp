# cs2gs: translating Roslyn analyzer projects to G# analyzers

Status: implemented through the map/idiom layer (2026-08-19). The real
GSA0001, GSA0002, GSA0003, and GSA0004 sources translate mechanically —
attribute swap, imports, kind/type/member maps, idiom rewrites — and bind
against `GSharp.Core` with CS2GS-ANALYZER-SHAPE review warnings only
(`Cs2Gs.Tests/Adr0169AnalyzerTranslationTests`). GSA0005 pattern-matches
deeply C#-specific syntax shapes and is pinned by a ratchet asserting its
translation stays LOUD (gap or binder failure, never silently wrong) until
its reviewed adaptation lands. Remaining follow-ups: the test-snippet
translator with marker provenance (§Test-harness) and the corpus-level
`AnalyzerParityStage` (§Parity).
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
    Roslyn `SymbolKind` → G# `SymbolKind`.
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

`AnalyzerTestHelper.cs` is ordinary C# and translates normally (rules 3/22
rewrite the Roslyn calls; the `[|...|]` marker-stripping logic is plain string
code). The hard part is the **embedded C# snippets** — raw strings of analyzed
code inside tests. For functional equivalence they must become G# snippets.

Approach: nested cs2gs invocation at translation time, not manual porting.

- New `Cs2Gs.Translator/Analyzers/SnippetTranslator.cs`:
  `TranslateSnippet(csharpWithMarkers) → (gsharpWithMarkers, diagnostics)`.
  Triggered by a guard on string literals flowing into a parameter the map
  marks as analyzed-source (the translated verifier's `source` parameter).
- Marker preservation: strip markers recording the anchor node (innermost
  syntax node starting at each marker span), translate, re-place markers via
  origin provenance — an optional `Origin` (source `SyntaxReference`)
  annotation on `Cs2Gs.CodeModel` nodes surfaced by `GSharpPrinter` as an
  origin→output-span table. Anchors with no 1:1 counterpart get a best-guess
  position plus the new `CS2GS-ANALYZER-SNIPPET` warning → human review.
- Golden files of translated snippets (via `test/Shared/GoldenFile.cs`) make
  review diffable. Manual fallback (warning + TODO marker) keeps the milestone
  shippable if provenance lands partially.

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
  verifier with exact `[|...|]` locations over translated snippets.
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
