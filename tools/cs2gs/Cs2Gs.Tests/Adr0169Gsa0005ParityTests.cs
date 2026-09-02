// <copyright file="Adr0169Gsa0005ParityTests.cs" company="GSharp">
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
using GSharp.InternalAnalyzers;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 §Parity for GSA0005 (issue #3795). The corpus-level parity harness
/// covered GSA0001 only, so a translated rule that stopped firing altogether
/// passed every negative test and was caught only by a full migration run —
/// which is exactly how #3795 escaped. This class runs the REAL Roslyn
/// <see cref="RewriterClonePreservationAnalyzer"/> over each snippet of
/// <c>test/InternalAnalyzers.Tests</c>, translates BOTH the snippet and the
/// analyzer with cs2gs, compiles the translated analyzer with the real G#
/// compiler, runs it over the translated snippet through the same host gsc
/// uses, and requires the two diagnostic sets to match.
/// </summary>
/// <remarks>
/// The negatives are non-vacuous BY CONSTRUCTION: they share one parameterised
/// path with the positives, and the positives assert the translated analyzer
/// really fires. A rule that reports nothing fails the positives, so "no
/// diagnostics" can no longer pass for the wrong reason.
/// </remarks>
public sealed class Adr0169Gsa0005ParityTests : IDisposable
{
    /// <summary>
    /// The two-form union the fixture shares: a variable-receiver constructor
    /// and an interface-static one, the latter omitting <c>Receiver</c> and
    /// carrying <c>InterfaceType</c> instead. Copied verbatim from
    /// <c>RewriterClonePreservationAnalyzerTests</c> so parity is measured on
    /// the shapes the migrated suite actually runs.
    /// </summary>
    private const string Model = """
class Node { }

class FieldNode : Node
{
    public FieldNode(Node receiver, string field, Node value) { Receiver = receiver; Field = field; Value = value; }

    public FieldNode(string field, string interfaceType, Node value) { Field = field; InterfaceType = interfaceType; Value = value; }

    public Node Receiver { get; }

    public string InterfaceType { get; }

    public string Field { get; }

    public Node Value { get; }
}

class BoundTreeRewriter
{
    protected virtual Node RewriteFieldNode(FieldNode node)
    {
        var value = node.Value;
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, value)
            : new FieldNode(node.Receiver, node.Field, value);
    }
}
""";

    private const string RebuildsWithoutDiscriminator = """

class Broken : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

    private const string BranchesOnDiscriminator = """

class Fixed : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

    private const string DoesNotRebuild = """

class Delegating : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.Field == "skip" ? node : base.RewriteFieldNode(node);
    }
}
""";

    private const string DelegatesOnOnePathOnly = """

class PartlyDelegating : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        if (node.Field == "skip")
        {
            return base.RewriteFieldNode(node);
        }

        return new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

    private const string ReplacesEveryFormsMember = """

class Replacing : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, new Node())
            : new FieldNode(node.Receiver, node.Field, new Node());
    }
}
""";

    private const string ReadsThroughAHelper = """

class ViaHelper : BoundTreeRewriter
{
    private static string Discriminator(FieldNode node) => node.InterfaceType;

    protected override Node RewriteFieldNode(FieldNode node)
    {
        var owner = Discriminator(node);
        return owner != null
            ? new FieldNode(node.Field, owner, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

    private const string ReadsThroughTheRewrittenBaseResult = """

class ViaBaseResult : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        var rewritten = (FieldNode)base.RewriteFieldNode(node);
        return rewritten.InterfaceType != null
            ? new FieldNode(rewritten.Field, rewritten.InterfaceType, rewritten.Value)
            : new FieldNode(rewritten.Receiver, rewritten.Field, rewritten.Value);
    }
}
""";

    private readonly DirectoryInfo workDirectory = Directory.CreateTempSubdirectory("cs2gs-gsa0005-parity");

    /// <summary>
    /// The fixture's snippets, each with the number of GSA0005 diagnostics the
    /// REAL Roslyn analyzer produces. The count is asserted against Roslyn too,
    /// so a wrong expectation fails on the C# side rather than silently
    /// weakening the G# side.
    /// </summary>
    /// <returns>Snippet name, source, expected diagnostic count.</returns>
    public static TheoryData<string, string, int> Snippets() => new()
    {
        { "ReportsAnOverrideThatRebuildsWithoutTheDiscriminator", Model + RebuildsWithoutDiscriminator, 1 },
        { "DelegatingOnOnePathDoesNotExcuseDroppingOnAnother", Model + DelegatesOnOnePathOnly, 1 },
        { "AcceptsAnOverrideThatBranchesOnTheDiscriminator", Model + BranchesOnDiscriminator, 0 },
        { "AcceptsAnOverrideThatDoesNotRebuild", Model + DoesNotRebuild, 0 },
        { "IgnoresMembersEveryConstructorRequires", Model + ReplacesEveryFormsMember, 0 },
        { "AcceptsReadsReachedThroughAHelper", Model + ReadsThroughAHelper, 0 },
        { "AcceptsReadsThroughTheRewrittenBaseResult", Model + ReadsThroughTheRewrittenBaseResult, 0 },
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
    /// Roslyn GSA0005 and the cs2gs-translated GSA0005 must agree on every
    /// snippet of the fixture — including the negatives, which are only
    /// meaningful because the positives on this same path demand a diagnostic.
    /// </summary>
    /// <param name="name">The fixture test the snippet comes from.</param>
    /// <param name="csharpSource">The C# snippet.</param>
    /// <param name="expected">The expected GSA0005 count.</param>
    [Theory]
    [MemberData(nameof(Snippets))]
    public void TranslatedGsa0005_MatchesRoslynGsa0005(string name, string csharpSource, int expected)
    {
        Assert.Equal(expected, RunRoslynGsa0005(csharpSource));

        SnippetTranslationResult snippet = SnippetTranslator.Translate(csharpSource);
        Assert.NotNull(snippet.GsWithMarkers);
        Assert.Empty(snippet.UnplacedMarkers);

        int produced = RunTranslatedGsa0005(snippet.GsWithMarkers);
        Assert.True(
            expected == produced,
            $"{name}: Roslyn GSA0005 produced {expected} diagnostic(s), the translated analyzer produced {produced}.");
    }

    private static int RunRoslynGsa0005(string csharpSource)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", csharpSource) });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        return project.Compilation
            .WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new RewriterClonePreservationAnalyzer()))
            .GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult()
            .Count(d => d.Id == "GSA0005");
    }

    private int RunTranslatedGsa0005(string gsWithMarkers)
    {
        string analyzerDll = CompileTranslatedGsa0005();
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
        return produced.Count(d => d.Id == "GSA0005");
    }

    /// <summary>
    /// Translates the real GSA0005 source in analyzer mode and compiles it into
    /// a loadable G# analyzer assembly.
    /// </summary>
    /// <returns>The analyzer assembly path.</returns>
    private string CompileTranslatedGsa0005()
    {
        string repoRoot = Adr0169TranslatedAnalyzerHarness.FindRepoRoot();
        string analyzerDirectory = Path.Combine(repoRoot, "src", "Analyzers", "InternalAnalyzers");
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("RewriterClonePreservationAnalyzer.cs", File.ReadAllText(Path.Combine(analyzerDirectory, "RewriterClonePreservationAnalyzer.cs"))),
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
            AssemblyName = "TranslatedGsa0005",
        };

        string dllPath = Path.Combine(workDirectory.FullName, "TranslatedGsa0005.dll");
        using (var peStream = File.Create(dllPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "TranslatedGsa0005");
            Assert.True(
                result.Success,
                "Translated GSA0005 should compile:\n" + string.Join("\n", result.Diagnostics.Where(d => d.IsError).Select(d => d.Message)));
        }

        return dllPath;
    }
}
