// <copyright file="TranslatorExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests.Coverage

import Cs2Gs.Tests
import Cs2Gs.Translator
import Cs2Gs.Translator.Coverage
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// The translator-exhaustiveness contract (ADR-0138): the
/// (cref:UnsupportedByDesign) registry and the construct inventory's
/// UnsupportedByDesign rows are the same set; every deliberately-rejected
/// fixture produces exactly the recorded by-design diagnostic; and an
/// unhandled construct that is NOT registered is classified as a gap
/// (`CS2GS-GAP`) — an accidental fallthrough can never masquerade as a
/// design decision.
/// Unsupported examples use `.cs.txt` so repository migration preserves
/// their input bytes as fixture data rather than translating them as source.
open class TranslatorExhaustivenessTests {
    @Fact
    func Registry_MatchesInventoryUnsupportedRows() {
        let inventory = ConstructInventory.Load(InventoryPath())
        let inventoryRows = inventory
            .Entries
            .Where((e ConstructEntry) -> e.Status == ConstructStatus.UnsupportedByDesign)
            .ToDictionary(
            func (e ConstructEntry) string {
                return e.Kind
            },
            (e ConstructEntry) -> e.Rationale.ToString(),
            StringComparer.Ordinal
        )
        let registryRows = UnsupportedByDesign.Snapshot().ToDictionary(
            func (p KeyValuePair[SyntaxKind, UnsupportedRationale]) string {
                return p.Key.ToString()
            },
            (p KeyValuePair[SyntaxKind, UnsupportedRationale]) -> p.Value.ToString(),
            StringComparer.Ordinal
        )
        let onlyInventory = inventoryRows
            .Keys
            .Except(registryRows.Keys, StringComparer.Ordinal)
            .OrderBy((k string) -> k, StringComparer.Ordinal)
            .ToList()
        let onlyRegistry = registryRows
            .Keys
            .Except(inventoryRows.Keys, StringComparer.Ordinal)
            .OrderBy((k string) -> k, StringComparer.Ordinal)
            .ToList()
        let mismatched = inventoryRows
            .Keys
            .Intersect(registryRows.Keys, StringComparer.Ordinal)
            .Where((k string) -> inventoryRows[k] != registryRows[k])
            .Select((k string) -> "$k: inventory=${inventoryRows[k]} registry=${registryRows[k]}")
            .ToList()
        Assert.True(
            onlyInventory.Count == 0 && onlyRegistry.Count == 0 && mismatched.Count == 0,
            "UnsupportedByDesign registry and inventory diverged.\n" +
                (`Only in inventory: ` + "${string.Join(", ", onlyInventory)}" + `
`) +
                (`Only in registry: ` + "${string.Join(", ", onlyRegistry)}" + `
`) +
                "Rationale mismatches: ${string.Join("; ", mismatched)}"
        )
    }

    @Theory
    @InlineData("MakeRefExpression")
    @InlineData("RefTypeExpression")
    @InlineData("RefValueExpression")
    @InlineData("ArgListExpression")
    func UnsupportedFixture_ProducesByDesignDiagnostic(kind string) {
        let fixturePath = Path.Combine(
            RepoRoot(),
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Fixtures",
            "Grid",
            "Unsupported",
            kind + ".cs.txt"
        )
        Assert.True(File.Exists(fixturePath), "missing fixture $fixturePath")
        let context = Translate(File.ReadAllText(fixturePath))
        let diagnostic TranslationDiagnostic? = context.Diagnostics.FirstOrDefault(
            (d TranslationDiagnostic) -> d.IsUnsupported && d.ConstructKind == kind
        )
        Assert.True(diagnostic != nil, (`expected an Unsupported diagnostic for ` + "$kind" + `; got:
`) + string.Join("\n", context.Diagnostics.Select((d TranslationDiagnostic) -> d.ToString())))
        Assert.Equal(UnsupportedClassification.ByDesign, diagnostic!!.Classification)
        Assert.Equal(UnsupportedRationale.NoGsharpConstruct, diagnostic!!.Rationale)
    }

    @Fact
    func UnregisteredConstruct_IsClassifiedAsGap() {
        // Issue #1906: the function-pointer-type snippet previously probed
        // here now TRANSLATES (delegate*<...> maps to G#'s *func(T) R /
        // unmanaged[CC] (T) -> R forms), so it can no longer serve as an
        // "accidental gap" probe. Rather than pin this test to whatever real
        // C# construct happens to still be unimplemented today — which would
        // only break again the next time cs2gs gains coverage — this drives
        // the exact choke point (TranslationContext.ReportUnsupported)
        // directly against a synthetic, deliberately-unregistered kind:
        // NumericLiteralExpression is a fully-implemented, always-supported
        // construct that will never be added to the UnsupportedByDesign
        // registry, so ReportUnsupported must classify it as an accidental
        // Gap. This makes the test permanently meaningful regardless of how
        // much real coverage cs2gs gains.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Fixture.cs", "class C { int M() => 1; }")})
        Assert.True(
            project.BoundWithoutErrors,
            "fixture should bind with no C# errors:\n" + string.Join("\n", project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let literal = document.GetRoot().DescendantNodes().OfType[LiteralExpressionSyntax]().Single()
        Assert.Equal(SyntaxKind.NumericLiteralExpression, literal.Kind())
        Assert.False(
            UnsupportedByDesign.TryGetRationale(literal.Kind(), out _),
            "probe kind must stay unregistered for this test to be meaningful"
        )
        context.ReportUnsupported(literal, "synthetic gap probe (test-only; not a real translation gap)")
        let diagnostic TranslationDiagnostic? = context.Diagnostics.FirstOrDefault(
            (d TranslationDiagnostic) -> d.IsUnsupported
        )
        Assert.True(diagnostic != nil, "expected the synthetic probe to record an Unsupported diagnostic.")
        Assert.Equal(UnsupportedClassification.Gap, diagnostic!!.Classification)
        Assert.Equal(UnsupportedRationale.None, diagnostic!!.Rationale)
    }

    @Fact
    func Registry_CoversOnlySurfaceKinds() {
        let surface = HashSet[string](RoslynSurface.NodeKindNames(), StringComparer.Ordinal)
        let offSurface = UnsupportedByDesign
            .Snapshot()
            .Keys
            .Select((k SyntaxKind) -> k.ToString())
            .Where((k string) -> !surface.Contains(k))
            .ToList()
        Assert.True(offSurface.Count == 0, "registry entries off the node surface: " + string.Join(", ", offSurface))
    }

    shared {
        private func Translate(source string) TranslationContext {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Fixture.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "fixture should bind with no C# errors:\n" + string.Join("\n", project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            CSharpToGSharpTranslator().TranslateDocument(document, context)
            return context
        }

        private func InventoryPath() string -> Path.Combine(
            RepoRoot(),
            ConstructInventory.RepoRelativePath.Replace('/', Path.DirectorySeparatorChar)
        )

        private func RepoRoot() string -> TestFixtureSource.Root
    }
}
