// <copyright file="Adr0169Gsa0006ParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 §Parity for GSA0006 (issue #4172), following the same rationale
/// #3795 established for GSA0005 (<see cref="Adr0169Gsa0005ParityTests"/>):
/// a corpus-level translate+compile guard proves the migrated analyzer
/// BUILDS, never that it still FIRES. GSA0006's own rollout found exactly
/// this gap — a compiling-but-silently-inert translated form is worse than a
/// translation failure, because nothing signals it. This class runs the
/// REAL Roslyn <c>BaseClassCycleUnsafeWalkAnalyzer</c> over each snippet,
/// translates BOTH the snippet and the analyzer with cs2gs, compiles the
/// translated analyzer with the real G# compiler, runs it over the
/// translated snippet through the same host <c>gsc</c> uses, and requires
/// the two diagnostic sets to match.
/// </summary>
/// <remarks>
/// The negatives are non-vacuous BY CONSTRUCTION: the positives on this same
/// path assert the translated analyzer really fires, so "no diagnostics"
/// can no longer pass for the wrong reason (a rule that reports nothing at
/// all fails the positives too).
/// </remarks>
public sealed class Adr0169Gsa0006ParityTests : IDisposable
{
    /// <summary>The model every snippet shares: a minimal stand-in for <c>StructSymbol</c>.</summary>
    private const string Model = """
class StructSymbol
{
    public StructSymbol BaseClass;
}
""";

    private const string WhileLoopWalk = """

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        while (current != null)
        {
            current = current.BaseClass;
        }
    }
}
""";

    // Issue #4177 (fixed): a C-style for-loop whose increment clause is a
    // general assignment (not `++`/`--`) — exactly this shape — used to
    // translate to invalid G# (a gsc parser gap: the for-clause post/
    // increment header suppressed the object-initializer struct-literal
    // ambiguity for a call-/indexer-tailed post (#1023) but not the sibling
    // bare-identifier-tailed one, so `current = current.BaseClass` directly
    // before this loop's empty body was mis-parsed as `BaseClass`'s
    // struct-literal initializer). Restored here now that the parser fix
    // lands.
    private const string ForLoopWalk = """

class Walker
{
    void Walk(StructSymbol s)
    {
        for (var current = s; current != null; current = current.BaseClass)
        {
        }
    }
}
""";

    private const string DoWhileLoopWalk = """

class Walker
{
    void Walk(StructSymbol s)
    {
        var current = s;
        do
        {
            current = current.BaseClass;
        }
        while (current != null);
    }
}
""";

    private const string SingleHopFetchIntoNewVariable = """

class Checker
{
    bool HasBase(StructSymbol s)
    {
        var parent = s.BaseClass;
        return parent != null;
    }
}
""";

    private const string GuardedWalkThroughHierarchyHelperModel = """
class StructSymbol
{
    public StructSymbol BaseClass;

    public System.Collections.Generic.List<StructSymbol> GetHierarchy()
    {
        var hierarchy = new System.Collections.Generic.List<StructSymbol>();
        var current = this;
        while (current != null)
        {
            hierarchy.Add(current);
            current = current.BaseClass;
        }

        return hierarchy;
    }
}
""";

    private const string GuardedWalkThroughHierarchyHelper = """

class Walker
{
    bool FindAncestor(StructSymbol container, StructSymbol target)
    {
        var chain = container.GetHierarchy();
        for (var i = 1; i < chain.Count; i++)
        {
            if (chain[i] == target)
            {
                return true;
            }
        }

        return false;
    }
}
""";

    private readonly DirectoryInfo workDirectory = Directory.CreateTempSubdirectory("cs2gs-gsa0006-parity");

    /// <summary>
    /// The fixture's snippets, each with the number of GSA0006 diagnostics the
    /// REAL Roslyn analyzer produces. The count is asserted against Roslyn
    /// too, so a wrong expectation fails on the C# side rather than silently
    /// weakening the G# side.
    /// </summary>
    /// <returns>Snippet name, source, expected diagnostic count.</returns>
    public static TheoryData<string, string, int> Snippets() => new()
    {
        { "ReportsWhileLoopWalk", Model + WhileLoopWalk, 1 },
        { "ReportsForLoopWalk", Model + ForLoopWalk, 1 },
        { "ReportsDoWhileLoopWalk", Model + DoWhileLoopWalk, 1 },
        { "IgnoresSingleHopFetchIntoNewVariable", Model + SingleHopFetchIntoNewVariable, 0 },
        { "IgnoresGuardedWalkThroughHierarchyHelper", GuardedWalkThroughHierarchyHelperModel + GuardedWalkThroughHierarchyHelper, 0 },
    };

    /// <inheritdoc />
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

    /// <summary>
    /// Roslyn GSA0006 and the cs2gs-translated GSA0006 must agree on every
    /// snippet of the fixture — including the negatives, which are only
    /// meaningful because the positives on this same path demand a
    /// diagnostic.
    /// </summary>
    /// <param name="name">The fixture test the snippet comes from.</param>
    /// <param name="csharpSource">The C# snippet.</param>
    /// <param name="expected">The expected GSA0006 count.</param>
    [Theory]
    [MemberData(nameof(Snippets))]
    public void TranslatedGsa0006_MatchesRoslynGsa0006(string name, string csharpSource, int expected)
    {
        Assert.Equal(expected, RunRoslynGsa0006(csharpSource));

        SnippetTranslationResult snippet = SnippetTranslator.Translate(csharpSource);
        Assert.NotNull(snippet.GsWithMarkers);
        Assert.Empty(snippet.UnplacedMarkers);

        int produced = RunTranslatedGsa0006(snippet.GsWithMarkers);
        Assert.True(
            expected == produced,
            $"{name}: Roslyn GSA0006 produced {expected} diagnostic(s), the translated analyzer produced {produced}.");
    }

    private static int RunRoslynGsa0006(string csharpSource)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", csharpSource) });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        // Issue #3880: see Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer —
        // the control is compiled from the analyzer's own source so the Roslyn
        // half of the parity check survives self-migration.
        DiagnosticAnalyzer roslynAnalyzer = Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer(
            "BaseClassCycleUnsafeWalkAnalyzer.cs", "BaseClassCycleUnsafeWalkAnalyzer");
        return project.Compilation
            .WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(roslynAnalyzer))
            .GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult()
            .Count(d => d.Id == "GSA0006");
    }

    private int RunTranslatedGsa0006(string gsWithMarkers)
    {
        string analyzerDll = CompileTranslatedGsa0006();
        string gs = gsWithMarkers.Replace("[|", string.Empty, StringComparison.Ordinal)
            .Replace("|]", string.Empty, StringComparison.Ordinal);

        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(gs, "snippet.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)));

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            Array.Empty<string>());
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree) { IsLibrary = true };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + gs);

        var produced = GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost.Run(compilation, new[] { analyzerDll });
        Assert.DoesNotContain(produced, d => d.Id is "GS9300" or "GS9301" or "GS9304");
        return produced.Count(d => d.Id == "GSA0006");
    }

    /// <summary>
    /// Translates the real GSA0006 source in analyzer mode and compiles it
    /// into a loadable G# analyzer assembly.
    /// </summary>
    /// <returns>The analyzer assembly path.</returns>
    private string CompileTranslatedGsa0006()
    {
        string repoRoot = Adr0169TranslatedAnalyzerHarness.FindRepoRoot();
        string analyzerDirectory = Path.Combine(repoRoot, "src", "Analyzers", "InternalAnalyzers");
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("BaseClassCycleUnsafeWalkAnalyzer.cs", File.ReadAllText(Path.Combine(analyzerDirectory, "BaseClassCycleUnsafeWalkAnalyzer.cs"))),
            ("DiagnosticDescriptors.cs", File.ReadAllText(Path.Combine(analyzerDirectory, "DiagnosticDescriptors.cs"))),
        });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        var trees = new List<GSharp.Core.CodeAnalysis.Syntax.SyntaxTree>();
        foreach (LoadedDocument document in project.Documents.Where(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs"))
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
            trees.Add(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, Path.GetFileName(document.FilePath) + ".gs")));
        }

        Assert.All(trees, tree => Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message))));

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees.ToArray())
        {
            IsLibrary = true,
            AssemblyName = "TranslatedGsa0006",
        };

        string dllPath = Path.Combine(workDirectory.FullName, "TranslatedGsa0006.dll");
        using (var peStream = File.Create(dllPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "TranslatedGsa0006");
            Assert.True(
                result.Success,
                "Translated GSA0006 should compile:\n" + string.Join("\n", result.Diagnostics.Where(d => d.IsError).Select(d => d.Message)));
        }

        return dllPath;
    }
}
