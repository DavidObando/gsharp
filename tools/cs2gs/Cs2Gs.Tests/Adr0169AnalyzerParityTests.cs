// <copyright file="Adr0169AnalyzerParityTests.cs" company="GSharp">
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
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 / docs/cs2gs-analyzer-translation.md §Parity: the end-to-end
/// functional-equivalence check. The REAL Roslyn GSA0001 runs over a C#
/// corpus; cs2gs translates BOTH the corpus and the analyzer; the translated
/// analyzer is compiled by the real G# compiler, loaded through
/// GSharpAnalyzerHost, and run over the translated corpus; the two diagnostic
/// sets must match on (id, per-file ordinal) — locations shift under
/// translation, so exact line/column is deliberately not compared.
/// </summary>
public sealed class Adr0169AnalyzerParityTests : IDisposable
{
    // Exercises every GSA0001 behavior class: resolver exemption, flagged
    // member-access reads (including chained receivers), write exemption
    // (C#: assignment-LHS parent walk; G#: index writes parse as
    // MemberIndexAssignmentExpression — the row-8 shape divergence), and the
    // unflagged bare-identifier form.
    private const string CorpusSource = @"
using System.Collections.Generic;

namespace App
{
    public class Emitter
    {
        public Dictionary<int, int> StructFieldDefs = new Dictionary<int, int>();

        public int ResolveFieldToken(int field)
        {
            return this.StructFieldDefs[field];
        }

        public int Leak(int field)
        {
            return this.StructFieldDefs[field];
        }

        public int ChainedLeak(Emitter other, int field)
        {
            return other.StructFieldDefs[field];
        }

        public void Populate(int field, int token)
        {
            this.StructFieldDefs[field] = token;
        }

        public int BareRead(int field)
        {
            return StructFieldDefs[field];
        }
    }
}
";

    private readonly DirectoryInfo workDirectory = Directory.CreateTempSubdirectory("cs2gs-analyzer-parity");

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
    public void TranslatedGsa0001_MatchesRoslynGsa0001_OverTranslatedCorpus()
    {
        // 1. The real Roslyn analyzer over the C# corpus.
        IReadOnlyList<string> roslynIds = RunRoslynAnalyzer();
        Assert.Equal(new[] { "GSA0001", "GSA0001", "GSA0001" }, roslynIds);

        // 2. cs2gs translates the corpus (ordinary mode).
        string gsCorpus = TranslateOrdinary("Corpus.cs", CorpusSource);

        // 3. cs2gs translates the analyzer (analyzer mode), and the real G#
        //    compiler compiles it into an analyzer assembly.
        string analyzerDllPath = Adr0169TranslatedAnalyzerHarness.CompileTranslatedGsa0001(workDirectory.FullName);

        // 4. The translated analyzer runs over the translated corpus through
        //    the same host gsc uses.
        var corpusTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(gsCorpus, "corpus.gs"));
        Assert.True(corpusTree.Diagnostics.IsEmpty, string.Join("\n", corpusTree.Diagnostics.Select(d => d.Message)));

        using var corpusResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.WithRuntimeReferences(
            Array.Empty<string>());
        var corpusCompilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(corpusResolver, corpusTree)
        {
            IsLibrary = true,
        };
        var corpusErrors = corpusCompilation.GlobalScope.Diagnostics
            .Concat(corpusCompilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        Assert.True(corpusErrors.Count == 0, string.Join("\n", corpusErrors.Select(d => d.Message)) + "\n---\n" + gsCorpus);

        var produced = GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost.Run(
            corpusCompilation,
            new[] { analyzerDllPath });

        Assert.DoesNotContain(produced, d => d.Id is "GS9300" or "GS9301" or "GS9304");
        IReadOnlyList<string> gsIds = produced
            .Where(d => d.Id == "GSA0001")
            .OrderBy(d => d.Location.Span.Start)
            .Select(d => d.Id)
            .ToList();

        // 5. Parity: same rule fires the same number of times over the
        //    equivalent code, with the write and resolver exemptions intact.
        Assert.Equal(roslynIds, gsIds);
    }

    private static IReadOnlyList<string> RunRoslynAnalyzer()
    {
        LoadedCSharpProject corpus = CSharpProjectLoader.LoadInMemory(new[] { ("Corpus.cs", CorpusSource) });
        Assert.True(corpus.BoundWithoutErrors, string.Join("\n", corpus.ErrorDiagnostics));

        // Issue #3880: the Roslyn control is compiled from the analyzer's own
        // source rather than named through the InternalAnalyzers project
        // reference, which does not survive self-migration (ADR-0169 retargets
        // that project onto the G# analyzer API).
        DiagnosticAnalyzer roslynAnalyzer = Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer(
            "StructFieldDefsReadAnalyzer.cs", "StructFieldDefsReadAnalyzer");
        var withAnalyzers = corpus.Compilation.WithAnalyzers(
            ImmutableArray.Create<DiagnosticAnalyzer>(roslynAnalyzer));
        return withAnalyzers.GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult()
            .Where(d => d.Id == "GSA0001")
            .OrderBy(d => d.Location.SourceSpan.Start)
            .Select(d => d.Id)
            .ToList();
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
