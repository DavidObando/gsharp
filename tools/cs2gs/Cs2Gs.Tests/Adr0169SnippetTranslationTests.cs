// <copyright file="Adr0169SnippetTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 / docs/cs2gs-analyzer-translation.md §Test-harness: analyzer-test
/// C# snippets translate to G# snippets with their <c>[|…|]</c> markers
/// re-placed, and the migrated markers stay truthful — the translated GSA0001
/// (compiled by the real G# compiler) reports exactly at the re-placed marker.
/// Markers whose text does not survive translation surface loudly as
/// CS2GS-ANALYZER-SNIPPET, never silently misplaced.
/// </summary>
public sealed class Adr0169SnippetTranslationTests : IDisposable
{
    // The real snippet from StructFieldDefsReadAnalyzerTests.ReportsValueReadOutsideResolver.
    private const string PositiveSnippet = @"using System.Collections.Generic;

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
";

    // The real snippet from IgnoresWritesAndResolverReads (no markers — the
    // translated analyzer must stay silent over it).
    private const string NegativeSnippet = @"using System.Collections.Generic;

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
";

    private readonly DirectoryInfo workDirectory = Directory.CreateTempSubdirectory("cs2gs-snippet-tests");

    public void Dispose()
    {
        try
        {
            workDirectory.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void PositiveSnippet_MarkerSurvives_AndTranslatedAnalyzerReportsAtIt()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(PositiveSnippet);

        Assert.NotNull(result.GsWithMarkers);
        Assert.Empty(result.UnplacedMarkers);
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("[|this.cache.StructFieldDefs[field]|]", result.GsWithMarkers, StringComparison.Ordinal);

        // Re-placed markers denote expected-diagnostic REGIONS: G# parses
        // `x.y.Z[i]` with a narrower index node than C#'s element access, so
        // the migrated diagnostic starts inside the marker rather than at its
        // first character (the location shift the companion doc predicts).
        var markerRanges = new List<(int Start, int End)>();
        string cleanGs = StripMarkers(result.GsWithMarkers, markerRanges);
        var produced = RunTranslatedGsa0001(cleanGs);

        var actualStarts = produced
            .Where(d => d.Id == "GSA0001")
            .OrderBy(d => d.Location.Span.Start)
            .Select(d => d.Location.Span.Start)
            .ToList();
        Assert.Equal(markerRanges.Count, actualStarts.Count);
        for (var i = 0; i < markerRanges.Count; i++)
        {
            Assert.InRange(actualStarts[i], markerRanges[i].Start, markerRanges[i].End);
        }
    }

    [Fact]
    public void NegativeSnippet_TranslatedAnalyzerStaysSilent()
    {
        SnippetTranslationResult result = SnippetTranslator.Translate(NegativeSnippet);

        Assert.NotNull(result.GsWithMarkers);
        var produced = RunTranslatedGsa0001(result.GsWithMarkers);
        Assert.DoesNotContain(produced, d => d.Id == "GSA0001");
    }

    [Fact]
    public void UnplaceableMarker_SurfacesLoudly()
    {
        // `(object)value` translates to a G# conversion spelling, so the
        // marked text cannot be re-placed verbatim.
        SnippetTranslationResult result = SnippetTranslator.Translate(@"
class Holder
{
    object Box(int value) => [|(object)value|];
}
");

        Assert.Single(result.UnplacedMarkers);
        Assert.Contains(result.Diagnostics, d => d.DiagnosticId == SnippetTranslator.SnippetDiagnosticId);
        Assert.DoesNotContain("[|", result.GsWithMarkers, StringComparison.Ordinal);
    }

    private System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> RunTranslatedGsa0001(string gsSource)
    {
        string analyzerDll = Adr0169TranslatedAnalyzerHarness.CompileTranslatedGsa0001(workDirectory.FullName);

        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(gsSource, "snippet.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n---\n" + gsSource);

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(Array.Empty<string>());
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree)
        {
            IsLibrary = true,
        };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + gsSource);

        var produced = GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost.Run(compilation, new[] { analyzerDll });
        Assert.DoesNotContain(produced, d => d.Id is "GS9300" or "GS9301" or "GS9304");
        return produced;
    }

    private static string StripMarkers(string source, List<(int Start, int End)> markerRanges)
    {
        var result = new System.Text.StringBuilder(source.Length);
        var openStarts = new Stack<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|')
            {
                openStarts.Push(result.Length);
                i++;
                continue;
            }

            if (i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']')
            {
                if (openStarts.Count > 0)
                {
                    markerRanges.Add((openStarts.Pop(), result.Length));
                }

                i++;
                continue;
            }

            result.Append(source[i]);
        }

        return result.ToString();
    }

}
