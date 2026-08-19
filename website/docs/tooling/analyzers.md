---
title: "Code analyzers"
sidebar_position: 4
draft: false
---

# Code analyzers

G# has a code-analyzer system modeled closely on Roslyn analyzers in C#: small, focused rules that inspect your code during compilation and report extra diagnostics — warnings for risky patterns, project conventions, API misuse, and anything else a plain compile can't check. Analyzers run inside `gsc` during a build and inside the language server while you type, so the same rule that fails your CI build also squiggles in your editor.

If you have written a Roslyn analyzer before, everything here will feel familiar: the G# analyzer API deliberately mirrors Roslyn's shape, down to the type and method names.

## Using analyzers in a project

Analyzers ship as ordinary .NET assemblies. Wire one into a `.gsproj` with the `GsharpCodeAnalyzer` item:

```xml
<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <!-- A prebuilt analyzer assembly -->
    <GsharpCodeAnalyzer Include="analyzers/MyAnalyzers.dll" />
  </ItemGroup>
</Project>
```

When the analyzer lives in a sibling project of the same solution, reference it as an analyzer-only project reference — the analyzer runs against your code but is not linked into your output:

```xml
<ItemGroup>
  <ProjectReference Include="../MyAnalyzers/MyAnalyzers.gsproj"
                    OutputItemType="GsharpCodeAnalyzer"
                    ReferenceOutputAssembly="false" />
</ItemGroup>
```

During the build, the SDK forwards each analyzer to `gsc`, and analyzer diagnostics surface as regular MSBuild warnings and errors with file and line information:

```text
src/emitter.gs(41,16): warning MY0001: Read 'RawTable' through GetCachedValue instead of indexing directly
```

The language server picks up the same analyzer set after a build, so analyzer diagnostics also appear live in VS Code and Visual Studio. Analyzers in the editor run under a time budget — a rule that takes too long is switched off for the session rather than slowing down typing.

### Configuring severities

Analyzer diagnostics respect the same severity controls as compiler diagnostics:

- `<NoWarn>MY0001</NoWarn>` suppresses a rule.
- `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` and `<WarningsAsErrors>MY0001</WarningsAsErrors>` promote rules to errors.
- `.editorconfig` entries configure individual rules, using the same keys as .NET:

```ini
[*.gs]
dotnet_diagnostic.MY0001.severity = error
dotnet_diagnostic.MY0002.severity = suggestion
dotnet_diagnostic.MY0003.severity = none
```

Valid severities are `error`, `warning`, `suggestion` (rendered as an informational message), `silent` (kept for tooling but not shown), and `none` (fully disabled). Standard editorconfig layering applies: files closer to the source override files above them, and `root = true` stops the upward search. Sections apply when they can match `.gs` files — `[*]`, `[*.gs]`, and brace lists like `[*.{cs,gs}]`.

### Command-line usage

When driving `gsc` directly, pass analyzers and severity overrides yourself:

```bash
gsc src/*.gs /out:bin/app.dll \
    /gsanalyzer:analyzers/MyAnalyzers.dll \
    /gsdiag:MY0001=error /gsdiag:MY0002=none
```

- `/gsanalyzer:<file>` (repeatable) loads an analyzer assembly.
- `/gsdiag:<ID>=<none|hidden|info|warning|error>` overrides one rule's severity. Several entries can be combined with `,` or `;`.
- `/nowarn:` and `/warnaserror` work on analyzer IDs exactly as they do on compiler diagnostics.

Note that `/gsanalyzer:` is distinct from `/analyzer:`, which loads Roslyn *source generators* for the generator host.

### When an analyzer misbehaves

The compiler contains a faulty analyzer rather than failing your build:

- An analyzer that throws is disabled for the rest of the compilation, with a `GS9300` warning naming it.
- An assembly that fails to load, or contains no analyzers, produces a `GS9301` error.
- A diagnostic an analyzer did not declare up front is suppressed with a `GS9304` warning.

The full list of host diagnostics is in the [diagnostics reference](../ref/diagnostics.md).

## Writing an analyzer

An analyzer is a class deriving from `GSharpDiagnosticAnalyzer`, marked with the `@GSharpDiagnosticAnalyzer` attribute, in an assembly that references `GSharp.Core`. It declares the diagnostics it can produce and registers callbacks for the program elements it wants to inspect.

Here is a complete analyzer that flags index reads of anything named `RawTable`, unless the read happens inside the sanctioned `GetCachedValue` helper:

```gsharp
package MyAnalyzers

import System.Collections.Immutable
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Analyzers

@GSharpDiagnosticAnalyzer
class RawTableReadAnalyzer : GSharpDiagnosticAnalyzer {
    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(RawTableReadAnalyzer.Rule)

    override func Initialize(context AnalysisContext) {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
        context.EnableConcurrentExecution()
        context.RegisterSyntaxNodeAction(AnalyzeIndexRead, SyntaxKind.IndexExpression)
    }

    shared {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
            "MY0001",
            "Index reads should go through the cache helper",
            "Read '{0}' through GetCachedValue instead of indexing directly",
            "MyAnalyzers.Correctness",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true)

        private func AnalyzeIndexRead(context SyntaxNodeAnalysisContext) {
            let access = cast[IndexExpressionSyntax](context.Node)
            if access.Target.GetLastToken().Text == "RawTable" && !IsInsideCacheHelper(access) {
                context.ReportDiagnostic(Diagnostic.Create(RawTableReadAnalyzer.Rule, access.Location, "RawTable"))
            }
        }

        private func IsInsideCacheHelper(node SyntaxNode) bool {
            let enclosing = node.FirstAncestorOrSelf[FunctionDeclarationSyntax]()
            let name = enclosing?.Identifier.Text
            return name == "GetCachedValue"
        }
    }
}
```

The pieces:

- **`DiagnosticDescriptor`** describes a rule: a stable ID, a short title, a `string.Format`-style message template, a category, the default severity, and whether it is on by default. Pick an ID prefix unique to your analyzer package (`MY0001` above) so severity configuration and suppressions stay unambiguous.
- **`SupportedDiagnostics`** lists every rule the analyzer can produce. Reporting an undeclared ID is suppressed at runtime.
- **`Initialize`** registers the callbacks. It runs once per analysis. This analyzer subscribes to every `IndexExpression` node; the callback then checks the indexed target's name and walks up with `FirstAncestorOrSelf` to exempt the helper function.
- **`ReportDiagnostic`** files a diagnostic, usually created with `Diagnostic.Create(rule, location, args…)`. Every syntax node exposes its `Location`.

Analyzers can be written in G# (as above) or in C# against the same `GSharp.Core` API — both compile to ordinary .NET assemblies the host can load.

### What you can register for

`AnalysisContext` mirrors the Roslyn registration surface:

| Registration | Callback receives | Use it for |
|---|---|---|
| `RegisterSyntaxNodeAction(action, kinds…)` | `SyntaxNodeAnalysisContext` — the node, its `SemanticModel`, the compilation | Shape-based rules over specific `SyntaxKind`s |
| `RegisterSymbolAction(action, kinds…)` | `SymbolAnalysisContext` — a declared `Symbol` | Declaration-level rules (fields, properties, functions, types) |
| `RegisterBoundNodeAction(action, kinds…)` | `BoundNodeAnalysisContext` — a `BoundNode` from the bound tree | Semantic rules over resolved operations (calls, conversions, operators); the counterpart of Roslyn operation actions |
| `RegisterSyntaxTreeAction(action)` | `SyntaxTreeAnalysisContext` | Whole-file rules that only need syntax |
| `RegisterSemanticModelAction(action)` | `SemanticModelAnalysisContext` | Whole-file rules that need binding results |
| `RegisterCompilationStartAction` / `RegisterCompilationAction` | compilation-level contexts | Sharing state across callbacks, end-of-compilation summaries |

Two shims exist for familiarity: `EnableConcurrentExecution()` (currently a no-op — execution is sequential) and `ConfigureGeneratedCodeAnalysis(flags)`, which controls whether the analyzer sees generated (`.g.gs`) files.

### Working with syntax

Syntax trees expose the navigation helpers you would expect: every `SyntaxNode` has `Kind`, `Parent`, `Location`, `GetChildren()`, `Ancestors()`, `DescendantNodes()`, `FirstAncestorOrSelf[T]()`, and `GetLastToken()`. Pattern-match on the concrete node types (`IndexExpressionSyntax`, `AccessorExpressionSyntax`, `FunctionDeclarationSyntax`, …) to read structured members like `Target`, `LeftPart`/`RightPart`, or `Identifier`.

A useful difference from C#: writes to an indexed or member target parse as their own node kinds (`MemberIndexAssignmentExpression`, `CompoundIndexAssignmentExpression`, `MemberFieldAssignmentExpression`), so a rule about *reads* usually needs no assignment-target special-casing — check `node.Parent.Kind` when you do need to tell writes apart.

### Working with semantics

`SyntaxNodeAnalysisContext.SemanticModel` answers semantic questions about the node's file:

- `GetDeclaredSymbol(node)` — the symbol a declaration introduces.
- `GetSymbolInfo(node).Symbol` — the symbol an expression refers to (the invoked function of a call, the variable of a name, …).
- `GetTypeInfo(node).Type` — an expression's type.

Symbols carry the members analyzers lean on: `Name`, `Kind`, `ContainingType`, `ContainingNamespace` (the package name), `Locations`/`Location`, `DeclaringSyntaxNodes`, `ToDisplayString(DisplayFormat.FullyQualified)` for stable name comparisons, and on types `ConstructedFrom`, `ConstructedTypeArguments`, `IsValueType`, and `GetMembers()`. Use `SymbolEqualityComparer.Default` for symbol identity in sets and dictionaries.

Bound-node actions receive nodes from the compiler's bound tree — the semantic view of expressions and statements. `BoundNode.Syntax` links back to source for locations, `BoundExpression.Type` gives the resolved type, and `ConstantValue` exposes compile-time constants. Bound-node *kinds* are stable across releases; member shapes may evolve with the language.

## Testing an analyzer

The `GSharp.CodeAnalysis.Analyzers.Testing` library verifies analyzers against annotated source. Mark each expected diagnostic with `[|…|]` and hand the source to the verifier:

```csharp
using GSharp.CodeAnalysis.Analyzers.Testing;

[Fact]
public void FlagsRawTableReadsOutsideTheHelper()
{
    GSharpAnalyzerVerifier<RawTableReadAnalyzer>.VerifyAnalyzer(
        """
        package App

        class Table {
            var RawTable []int32 = []int32{1, 2, 3}

            func GetCachedValue(i int32) int32 {
                return this.RawTable[i]
            }

            func Leak(i int32) int32 {
                return this.[|RawTable[i]|]
            }
        }
        """,
        "MY0001");
}
```

The marker wraps the exact node the analyzer reports — here the index expression `RawTable[i]`, which in G# is a narrower node than the full `this.RawTable[i]` chain.

The verifier compiles the G# source, runs the analyzer through the real driver, and asserts the produced diagnostic IDs (in order) and their exact line and column against the markers. A test with no IDs asserts the analyzer stays silent. Mismatches fail with the full diagnostic list and the source, so broken expectations are easy to read.

## Migrating a Roslyn analyzer

If you are porting a C# project that ships Roslyn analyzers, [cs2gs](./cs2gs.md) has a dedicated analyzer translation mode. It recognizes analyzer projects automatically and rewrites `Microsoft.CodeAnalysis` usage to the G# analyzer API — attribute, base type, contexts, `SyntaxKind` values, node and symbol members, and the common idioms (`GetLocation()` becomes `.Location`, operation actions become bound-node actions, and so on). Because the two APIs share their shape, most analyzers translate mechanically.

Where C# and G# genuinely differ in syntax shape, the translator adapts the detection logic and flags the site with a `CS2GS-ANALYZER-SHAPE` warning so you can review it; anything it cannot map is reported loudly rather than translated wrong. Test suites come along too: marked test snippets are translated with their `[|…|]` markers re-placed, and unplaceable markers are called out for manual review.
