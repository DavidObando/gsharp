// <copyright file="Adr0169SnippetTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Text

/// ADR-0169 / docs/cs2gs-analyzer-translation.md §Test-harness: analyzer-test
/// C# snippets translate to G# snippets with their `[|…|]` markers
/// re-placed, and the migrated markers stay truthful — the translated GSA0001
/// (compiled by the real G# compiler) reports exactly at the re-placed marker.
/// Markers whose text does not survive translation surface loudly as
/// CS2GS-ANALYZER-SNIPPET, never silently misplaced.
class Adr0169SnippetTranslationTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-snippet-tests")

    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    @Fact
    func PositiveSnippet_MarkerSurvives_AndTranslatedAnalyzerReportsAtIt() {
        let result = SnippetTranslator.Translate(PositiveSnippet)
        Assert.NotNull(result.GsWithMarkers)
        Assert.Empty(result.UnplacedMarkers)
        Assert.DoesNotContain(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("[|this.cache.StructFieldDefs[field]|]", result.GsWithMarkers, StringComparison.Ordinal)
        // Re-placed markers denote expected-diagnostic REGIONS: G# parses
        // `x.y.Z[i]` with a narrower index node than C#'s element access, so
        // the migrated diagnostic starts inside the marker rather than at its
        // first character (the location shift the companion doc predicts).
        let markerRanges = List[(Start int32, End int32)]()
        let cleanGs = StripMarkers(result.GsWithMarkers, markerRanges)
        let produced = RunTranslatedGsa0001(cleanGs)
        let actualStarts = produced
            .Where((d Diagnostic) -> d.Id == "GSA0001")
            .OrderBy((d Diagnostic) -> d.Location.Span.Start)
            .Select((d Diagnostic) -> d.Location.Span.Start)
            .ToList()
        Assert.Equal(markerRanges.Count, actualStarts.Count)
        for var i = 0; i < markerRanges.Count; i++ {
            Assert.InRange(actualStarts[i], markerRanges[i].Start, markerRanges[i].End)
        }
    }

    @Fact
    func NegativeSnippet_TranslatedAnalyzerStaysSilent() {
        let result = SnippetTranslator.Translate(NegativeSnippet)
        Assert.NotNull(result.GsWithMarkers)
        let produced = RunTranslatedGsa0001(result.GsWithMarkers)
        Assert.DoesNotContain(produced, (d Diagnostic) -> d.Id == "GSA0001")
    }

    @Fact
    func UnplaceableMarker_SurfacesLoudly() {
        // `(object)value` translates to a G# conversion spelling, so the
        // marked text cannot be re-placed verbatim.
        let result = SnippetTranslator.Translate(`
class Holder
{
    object Box(int value) => [|(object)value|];
}
`)
        Assert.Single(result.UnplacedMarkers)
        Assert.Contains(
            result.Diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId
        )
        Assert.DoesNotContain("[|", result.GsWithMarkers, StringComparison.Ordinal)
    }

    private func RunTranslatedGsa0001(gsSource string?) ImmutableArray[Diagnostic] {
        let analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedGsa0001(workDirectory.FullName)
        let tree = SyntaxTree.Parse(SourceText.From(gsSource!!, "snippet.gs"))
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select((d Diagnostic) -> d.Message)) + `
---
` + gsSource)
        using let resolver = ReferenceResolver.WithRuntimeReferences(Array.Empty[string]())
        let compilation = Compilation(resolver, tree){IsLibrary = true}
        let errors = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where((d Diagnostic) -> d.IsError)
            .ToList()
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select((d Diagnostic) -> d.Message)) + `
---
` + gsSource)
        let produced = GSharpAnalyzerHost.Run(compilation, []string{analyzerDll})
        Assert.DoesNotContain(produced, (d Diagnostic) -> (d.Id is "GS9300" or "GS9301" or "GS9304"))
        return produced
    }

    shared {
        // The real snippet from StructFieldDefsReadAnalyzerTests.ReportsValueReadOutsideResolver.
        private const PositiveSnippet string = `using System.Collections.Generic;

class FieldSymbol { }
class Cache { public Dictionary<FieldSymbol, int> StructFieldDefs = new(); }
class Emitter
{
    private readonly Cache cache = new();
    void Emit(FieldSymbol field)
    {
        var token = [|this.cache.StructFieldDefs[field]|];
    }
}
`

        // The real snippet from IgnoresWritesAndResolverReads (no markers — the
        // translated analyzer must stay silent over it).
        private const NegativeSnippet string = `using System.Collections.Generic;

class FieldSymbol { }
class StructSymbol { }
class Cache { public Dictionary<FieldSymbol, int> StructFieldDefs = new(); }
class Emitter
{
    private readonly Cache cache = new();
    void Populate(FieldSymbol field, int handle)
    {
        this.cache.StructFieldDefs[field] = handle;
    }

    int ResolveFieldToken(StructSymbol symbol, FieldSymbol field)
        => this.cache.StructFieldDefs[field];

    int ResolveInterfaceFieldToken(StructSymbol symbol, FieldSymbol field)
        => this.cache.StructFieldDefs[field];
}
`

        private func StripMarkers(source string?, markerRanges List[(Start int32, End int32)]) string {
            let result = StringBuilder(source!!.Length)
            let openStarts = Stack[int32]()
            for var i = 0; i < source!!.Length; i++ {
                if i + 1 < source!!.Length && source!![i] == '[' && source!![i + 1] == '|' {
                    openStarts.Push(result.Length)
                    i++
                    continue
                }
                if i + 1 < source!!.Length && source!![i] == '|' && source!![i + 1] == ']' {
                    if openStarts.Count > 0 {
                        markerRanges.Add((openStarts.Pop(), result.Length))
                    }
                    i++
                    continue
                }
                result.Append(source!![i])
            }
            return result.ToString()
        }
    }
}
