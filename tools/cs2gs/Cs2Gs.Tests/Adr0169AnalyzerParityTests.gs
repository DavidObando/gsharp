// <copyright file="Adr0169AnalyzerParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Diagnostics
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text

/// ADR-0169 / docs/cs2gs-analyzer-translation.md §Parity: the end-to-end
/// functional-equivalence check. The REAL Roslyn GSA0001 runs over a C#
/// corpus; cs2gs translates BOTH the corpus and the analyzer; the translated
/// analyzer is compiled by the real G# compiler, loaded through
/// GSharpAnalyzerHost, and run over the translated corpus; the two diagnostic
/// sets must match on (id, per-file ordinal) — locations shift under
/// translation, so exact line/column is deliberately not compared.
class Adr0169AnalyzerParityTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-analyzer-parity")

    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    @Fact
    func TranslatedGsa0001_MatchesRoslynGsa0001_OverTranslatedCorpus() {
        // 1. The real Roslyn analyzer over the C# corpus.
        let roslynIds = RunRoslynAnalyzer()
        Assert.Equal([]string{"GSA0001", "GSA0001", "GSA0001"}, roslynIds)
        // 2. cs2gs translates the corpus (ordinary mode).
        let gsCorpus = TranslateOrdinary("Corpus.cs", CorpusSource)
        // 3. cs2gs translates the analyzer (analyzer mode), and the real G#
        //    compiler compiles it into an analyzer assembly.
        let analyzerDllPath = Adr0169TranslatedAnalyzerHarness.CompileTranslatedGsa0001(workDirectory.FullName)
        // 4. The translated analyzer runs over the translated corpus through
        //    the same host gsc uses.
        let corpusTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(gsCorpus, "corpus.gs"))
        Assert.True(
            corpusTree.Diagnostics.IsEmpty,
            string.Join("\n", corpusTree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))
        )
        using let corpusResolver = ReferenceResolver.WithRuntimeReferences(Array.Empty[string]())
        let corpusCompilation = GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation(corpusResolver, corpusTree){IsLibrary = true}
        let corpusErrors = corpusCompilation
            .GlobalScope
            .Diagnostics
            .Concat(corpusCompilation.BoundProgram.Diagnostics)
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToList()
        Assert.True(
            corpusErrors.Count == 0,
            string.Join("\n", corpusErrors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)) + `
---
` + gsCorpus
        )
        let produced = GSharpAnalyzerHost.Run(corpusCompilation, []string{analyzerDllPath})
        Assert.DoesNotContain(
            produced,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> (d.Id is "GS9300" or "GS9301" or "GS9304")
        )
        let gsIds IReadOnlyList[string] = produced
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GSA0001")
            .OrderBy((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Location.Span.Start)
            .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id)
            .ToList()
        // 5. Parity: same rule fires the same number of times over the
        //    equivalent code, with the write and resolver exemptions intact.
        Assert.Equal(roslynIds, gsIds)
    }

    shared {
        // Exercises every GSA0001 behavior class: resolver exemption, flagged
        // member-access reads (including chained receivers), write exemption
        // (C#: assignment-LHS parent walk; G#: index writes parse as
        // MemberIndexAssignmentExpression — the row-8 shape divergence), and the
        // unflagged bare-identifier form.
        private const CorpusSource string = `
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
`

        private func RunRoslynAnalyzer() IReadOnlyList[string] {
            let corpus = CSharpProjectLoader.LoadInMemory([](string, CorpusSource string){("Corpus.cs", CorpusSource)})
            Assert.True(corpus.BoundWithoutErrors, string.Join("\n", corpus.ErrorDiagnostics))
            // Issue #3880: the Roslyn control is compiled from the analyzer's own
            // source rather than named through the InternalAnalyzers project
            // reference, which does not survive self-migration (ADR-0169 retargets
            // that project onto the G# analyzer API).
            let roslynAnalyzer DiagnosticAnalyzer? = Adr0169TranslatedAnalyzerHarness.CompileRoslynAnalyzer(
                "StructFieldDefsReadAnalyzer.cs",
                "StructFieldDefsReadAnalyzer"
            )
            let withAnalyzers = corpus.Compilation.WithAnalyzers(
                ImmutableArray.Create[DiagnosticAnalyzer](roslynAnalyzer!!)
            )
            return withAnalyzers
                .GetAnalyzerDiagnosticsAsync()
                .GetAwaiter()
                .GetResult()
                .Where((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id == "GSA0001")
                .OrderBy((d Microsoft.CodeAnalysis.Diagnostic) -> d.Location.SourceSpan.Start)
                .Select((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id)
                .ToList()
        }

        private func TranslateOrdinary(fileName string, source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](fileName string, source string){(fileName, source)})
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator()
            let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == fileName)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return printed
        }
    }
}
