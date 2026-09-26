// <copyright file="Adr0169FunnelSurfaceParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Analyzers;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 §Parity for the analyzer-API rows issue #4436 adds (the surface
/// the ADR-0193 funnel analyzers use). The fixture analyzer is a copy of the
/// GSA0007 producer-funnel rule. Roslyn runs it over a C# corpus; cs2gs
/// translates both the corpus and the analyzer; the translated analyzer is
/// compiled by the real G# compiler, loaded through the host <c>gsc</c> uses,
/// and run over the translated corpus. The two must report the same
/// diagnostics. A row that translated but read the wrong member would compile
/// and then report differently, which is why this checks behavior and not
/// only translation.
/// </summary>
public sealed class Adr0169FunnelSurfaceParityTests : IDisposable
{
    private readonly DirectoryInfo workDirectory = Directory.CreateTempSubdirectory("cs2gs-funnel-surface-parity");

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

    [Fact]
    public void TranslatedFunnelRule_MatchesRoslyn_OverTranslatedCorpus()
    {
        // Door, door in a lambda, door in a field initializer, wrapper
        // factory, the five signature-accessor shapes (direct, declared local,
        // assignment, foreach, out var), method group and unattributed
        // property getter.
        AssertParity("FunnelSurfaceAnalyzer", "Corpus.cs", expected: 11);
    }

    [Fact]
    public void TranslatedTypeTestRule_MatchesRoslyn_OverTranslatedCorpus()
    {
        // A plain is test, a declaration pattern, a type pattern in a switch
        // arm and typeof — each once, with no double report for the plain
        // test. A C# recursive pattern over a property is not in the corpus:
        // cs2gs lowers it to `x is T && x.P == v` in ordinary mode, so it never
        // reaches G# as a pattern; the RecursivePattern row serves hand-written
        // G# `T{...}` patterns.
        // Also an imported property read, and an imported field read that
        // must not reach the property rule.
        AssertParity("TypeTestSurfaceAnalyzer", "TypeTestCorpus.cs", expected: 5);
    }

    [Fact]
    public void TranslatedDescendantsWalk_MatchesRoslyn_OverTranslatedCorpus()
    {
        // Assign: three local references (one of them the assignment target)
        // and one call. Lambda: the call inside the lambda body. PlainIs: one
        // local reference and no pattern.
        AssertParity("DescendantsSurfaceAnalyzer", "DescendantsCorpus.cs", expected: 6);
    }

    private void AssertParity(string analyzerName, string corpusName, int expected)
    {
        string corpus = Fixture(corpusName);

        // Asserted on the C# side too, so a wrong expectation cannot silently
        // weaken the G# side. Each corpus case is its own member, and every
        // diagnostic is keyed by the member that contains it, so a case that
        // stops reporting cannot be masked by another case reporting twice
        // with the same message (ADR-0154).
        IReadOnlyList<string> roslyn = RunRoslyn(analyzerName, corpusName, corpus);
        Assert.Equal(expected, roslyn.Count);

        IReadOnlyList<string> gsharp = RunTranslated(analyzerName, TranslateOrdinary(corpusName, corpus));
        Assert.Equal(roslyn, gsharp);
    }

    private static string Fixture(string name)
        => File.ReadAllText(Path.Combine(
            Adr0169TranslatedAnalyzerHarness.FindRepoRoot(),
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Fixtures",
            "Adr0169FunnelSurface",
            name));

    private static IReadOnlyList<(string Name, string Source)> AnalyzerSources(string analyzerName)
        => new[]
        {
            (analyzerName + ".cs", Fixture(analyzerName + ".cs")),
            ("DiagnosticDescriptors.cs", Fixture("DiagnosticDescriptors.cs")),
        };

    private static IReadOnlyList<string> RunRoslyn(string analyzerName, string corpusName, string corpus)
    {
        LoadedCSharpProject analyzerProject = CSharpProjectLoader.LoadInMemory(AnalyzerSources(analyzerName));
        Assert.True(analyzerProject.BoundWithoutErrors, string.Join("\n", analyzerProject.ErrorDiagnostics));
        using var peStream = new MemoryStream();
        EmitResult emitted = analyzerProject.Compilation.Emit(peStream);
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        Assembly assembly = Assembly.Load(peStream.ToArray());
        var analyzer = (DiagnosticAnalyzer)Activator.CreateInstance(
            assembly.GetType("GSharp.InternalAnalyzers." + analyzerName, throwOnError: true));

        LoadedCSharpProject corpusProject = CSharpProjectLoader.LoadInMemory(new[] { (corpusName, corpus) });
        Assert.True(corpusProject.BoundWithoutErrors, string.Join("\n", corpusProject.ErrorDiagnostics));
        return corpusProject.Compilation
            .WithAnalyzers(ImmutableArray.Create(analyzer))
            .GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult()
            .Where(d => d.Id == "GSA0007")
            .Select(d => RoslynMember(d.Location) + ": " + d.GetMessage(System.Globalization.CultureInfo.InvariantCulture))
            .OrderBy(m => m, StringComparer.Ordinal)
            .ToList();
    }

    private static string RoslynMember(Location location)
    {
        SyntaxNode node = location.SourceTree!.GetRoot().FindNode(location.SourceSpan);
        foreach (SyntaxNode ancestor in node.AncestorsAndSelf())
        {
            switch (ancestor)
            {
                case Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax method:
                    return method.Identifier.ValueText;
                case Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax property:
                    return property.Identifier.ValueText;
                case Microsoft.CodeAnalysis.CSharp.Syntax.VariableDeclaratorSyntax { Parent.Parent: Microsoft.CodeAnalysis.CSharp.Syntax.FieldDeclarationSyntax } field:
                    return field.Identifier.ValueText;
            }
        }

        return "?";
    }

    private static string GSharpMember(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree tree, GSharp.Core.CodeAnalysis.Text.TextSpan span)
    {
        // The innermost function or property declaration whose span covers
        // the diagnostic.
        string name = "?";
        var current = (GSharp.Core.CodeAnalysis.Syntax.SyntaxNode)tree.Root;
        while (current != null)
        {
            switch (current)
            {
                case GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax function:
                    name = function.Identifier.Text;
                    break;
                case GSharp.Core.CodeAnalysis.Syntax.PropertyDeclarationSyntax property:
                    name = property.Identifier.Text;
                    break;
                case GSharp.Core.CodeAnalysis.Syntax.FieldDeclarationSyntax field:
                    name = field.Identifier.Text;
                    break;
            }

            current = current.GetChildren().FirstOrDefault(child =>
                child.Span.Start <= span.Start && span.Start + span.Length <= child.Span.Start + child.Span.Length);
        }

        return name;
    }

    private IReadOnlyList<string> RunTranslated(string analyzerName, string gsCorpus)
    {
        string analyzerDll = CompileTranslatedAnalyzer(analyzerName);

        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(gsCorpus, "corpus.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n---\n" + gsCorpus);

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(Array.Empty<string>());
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree) { IsLibrary = true };
        var errors = compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors.Select(d => d.Message)) + "\n---\n" + gsCorpus);

        var produced = GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost.Run(compilation, new[] { analyzerDll });
        Assert.DoesNotContain(produced, d => d.Id is "GS9300" or "GS9301" or "GS9304");
        return produced
            .Where(d => d.Id == "GSA0007")
            .Select(d => GSharpMember(tree, d.Location.Span) + ": " + d.Message)
            .OrderBy(m => m, StringComparer.Ordinal)
            .ToList();
    }

    private string CompileTranslatedAnalyzer(string analyzerName)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(AnalyzerSources(analyzerName));
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation));

        var translator = new CSharpToGSharpTranslator(analyzerApiMode: true);
        var trees = new List<GSharp.Core.CodeAnalysis.Syntax.SyntaxTree>();
        var printedSources = new List<string>();
        foreach (LoadedDocument document in project.Documents.Where(d => Path.GetFileName(d.FilePath) != "GlobalUsings.cs"))
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
            printedSources.Add(printed);
            Assert.True(
                !context.Diagnostics.Any(d => d.Severity == TranslationSeverity.Unsupported),
                string.Join("\n", context.Diagnostics.Where(d => d.Severity == TranslationSeverity.Unsupported).Select(d => d.Message)));
            trees.Add(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
                GSharp.Core.CodeAnalysis.Text.SourceText.From(printed, Path.GetFileName(document.FilePath) + ".gs")));
        }

        Assert.All(trees, tree => Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message))));

        using var resolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            new[] { typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location });
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, trees.ToArray())
        {
            IsLibrary = true,
            AssemblyName = "Translated" + analyzerName,
        };

        string dllPath = Path.Combine(workDirectory.FullName, "Translated" + analyzerName + ".dll");
        using (var peStream = File.Create(dllPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Translated" + analyzerName);
            Assert.True(
                result.Success,
                "The translated funnel-surface analyzer should compile:\n"
                    + string.Join("\n", result.Diagnostics.Where(d => d.IsError).Select(d => d.Message))
                    + "\n---\n" + string.Join("\n=====\n", printedSources));
        }

        return dllPath;
    }

    private static string TranslateOrdinary(string fileName, string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { (fileName, source) });
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) == fileName);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return printed;
    }
}
