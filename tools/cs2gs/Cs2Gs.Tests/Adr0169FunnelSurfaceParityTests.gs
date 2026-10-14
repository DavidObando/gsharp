// <copyright file="Adr0169FunnelSurfaceParityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Analyzers
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Diagnostics
import Microsoft.CodeAnalysis.Emit
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Globalization

/// ADR-0169 §Parity for the analyzer-API rows issue #4436 adds (the surface
/// the ADR-0193 funnel analyzers use). The fixture analyzer is a copy of the
/// GSA0007 producer-funnel rule. Roslyn runs it over a C# corpus; cs2gs
/// translates both the corpus and the analyzer; the translated analyzer is
/// compiled by the real G# compiler, loaded through the host `gsc` uses,
/// and run over the translated corpus. The two must report the same
/// diagnostics. A row that translated but read the wrong member would compile
/// and then report differently, which is why this checks behavior and not
/// only translation.
class Adr0169FunnelSurfaceParityTests : IDisposable {
    private let workDirectory DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-funnel-surface-parity")

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            workDirectory.Delete(recursive: true)
        } catch (IOException) { }
    }

    @Fact
    func TranslatedFunnelRule_MatchesRoslyn_OverTranslatedCorpus() {
        // Door, door in a lambda, door in a field initializer, wrapper
        // factory, the six signature-accessor shapes (direct, declared local,
        // assignment, reassigned parameter, foreach, out var), method group
        // and unattributed property getter.
        AssertParity("FunnelSurfaceAnalyzer", "Corpus.cs", expected: 12)
    }

    @Fact
    func TranslatedTypeTestRule_MatchesRoslyn_OverTranslatedCorpus() {
        // A plain is test, a declaration pattern, a type pattern in a switch
        // arm and typeof — each once, with no double report for the plain
        // test. A C# recursive pattern over a property is not in the corpus:
        // cs2gs lowers it to `x is T && x.P == v` in ordinary mode, so it never
        // reaches G# as a pattern; the RecursivePattern row serves hand-written
        // G# `T{...}` patterns.
        // Also an imported property read, and an imported field read that
        // must not reach the property rule.
        AssertParity("TypeTestSurfaceAnalyzer", "TypeTestCorpus.cs", expected: 5)
    }

    @Fact
    func TranslatedDescendantsWalk_MatchesRoslyn_OverTranslatedCorpus() {
        // Assign: three local references (one of them the assignment target)
        // and one call. Lambda: the call inside the lambda body. PlainIs: one
        // local reference and no pattern.
        AssertParity("DescendantsSurfaceAnalyzer", "DescendantsCorpus.cs", expected: 6)
    }

    private func AssertParity(analyzerName string, corpusName string, expected int32) {
        let corpus = Adr0169FunnelSurfaceParityTests.Fixture(corpusName)
        // Asserted on the C# side too, so a wrong expectation cannot silently
        // weaken the G# side. Each corpus case is its own member, and every
        // diagnostic is keyed by the member that contains it, so a case that
        // stops reporting cannot be masked by another case reporting twice
        // with the same message (ADR-0154).
        let roslyn = RunRoslyn(analyzerName, corpusName, corpus)
        Assert.Equal(expected, roslyn.Count)
        let gsharp = RunTranslated(analyzerName, TranslateOrdinary(corpusName, corpus))
        Assert.Equal(roslyn, gsharp)
    }

    private func RunTranslated(analyzerName string, gsCorpus string) IReadOnlyList[string] {
        let analyzerDll = CompileTranslatedAnalyzer(analyzerName)
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(gsCorpus, "corpus.gs"))
        Assert.True(
            tree.Diagnostics.IsEmpty,
            string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)) + `
---
` + gsCorpus
        )
        using let resolver = ReferenceResolver.WithRuntimeReferences(Array.Empty[string]())
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(resolver, tree){IsLibrary = true}
        let errors = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            .ToList()
        Assert.True(
            errors.Count == 0,
            string.Join("\n", errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)) + `
---
` + gsCorpus
        )
        let produced = GSharpAnalyzerHost.Run(compilation, []string{analyzerDll})
        Assert.DoesNotContain(
            produced,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> (d.Id is "GS9300" or "GS9301" or "GS9304")
        )
        return produced
            .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GSA0007")
            .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> (GSharpMember(tree, d.Location.Span) + ": " + d.Message))
            .OrderBy((m string) -> m, StringComparer.Ordinal)
            .ToList()
    }

    private func CompileTranslatedAnalyzer(analyzerName string) string {
        let project = CSharpProjectLoader.LoadInMemory(AnalyzerSources(analyzerName))
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation))
        let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
        let trees = List[GSharp.Core.CodeAnalysis.Syntax.SyntaxTree]()
        let printedSources = List[string]()
        for document in project.Documents.Where(
            (d LoadedDocument) -> Path.GetFileName(d.FilePath) != "GlobalUsings.cs"
        ) {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            printedSources.Add(printed)
            Assert.True(
                !context.Diagnostics.Any((d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported),
                string.Join(
                    "\n",
                    context
                        .Diagnostics
                        .Where((d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported)
                        .Select((d TranslationDiagnostic) -> d.Message)
                )
            )
            trees.Add(
                GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SyntaxTree
                    .Parse(SourceText.From(printed, Path.GetFileName(document.FilePath) + ".gs"))
            )
        }
        Assert.All(
            trees,
            (tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree) -> Assert.True(
                tree.Diagnostics.IsEmpty,
                string.Join("\n", tree.Diagnostics.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message))
            )
        )
        using let resolver = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(GSharp.Core.CodeAnalysis.Diagnostic).Assembly.Location}
        )
        let compilation = GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation(resolver, trees.ToArray()){IsLibrary = true, AssemblyName = "Translated" + analyzerName}
        let dllPath = Path.Combine(workDirectory.FullName, "Translated" + analyzerName + ".dll")
        {
            using let peStream = File.Create(dllPath)
            let result = compilation.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Translated" + analyzerName
            )
            Assert.True(
                result.Success,
                "The translated funnel-surface analyzer should compile:\n" + string.Join(
                    "\n",
                    result
                        .Diagnostics
                        .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                        .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                ) +
                    `
---
` +
                    string.Join(`
=====
`, printedSources)
            )
        }
        return dllPath
    }

    shared {
        private func Fixture(name string) string -> File.ReadAllText(
            Path.Combine(
                Adr0169TranslatedAnalyzerHarness.FindRepoRoot(),
                "tools",
                "cs2gs",
                "Cs2Gs.Tests",
                "Fixtures",
                "Adr0169FunnelSurface",
                name
            )
        )

        private func AnalyzerSources(analyzerName string) IReadOnlyList[(Name string, Source string)] -> [](
            string,
            string
        ){
            (analyzerName + ".cs", Adr0169FunnelSurfaceParityTests.Fixture(analyzerName + ".cs")),
            ("DiagnosticDescriptors.cs", Adr0169FunnelSurfaceParityTests.Fixture("DiagnosticDescriptors.cs"))
        }

        private func RunRoslyn(analyzerName string, corpusName string, corpus string) IReadOnlyList[string] {
            let analyzerProject = CSharpProjectLoader.LoadInMemory(AnalyzerSources(analyzerName))
            Assert.True(analyzerProject.BoundWithoutErrors, string.Join("\n", analyzerProject.ErrorDiagnostics))
            using let peStream = MemoryStream()
            let emitted = analyzerProject.Compilation.Emit(peStream)
            Assert.True(
                emitted.Success,
                string.Join(
                    "\n",
                    emitted.Diagnostics.Where(
                        (d Microsoft.CodeAnalysis.Diagnostic) -> d.Severity == Microsoft
                            .CodeAnalysis
                            .DiagnosticSeverity
                            .Error
                    )
                )
            )
            let assembly = Assembly.Load(peStream.ToArray())
            let analyzer DiagnosticAnalyzer? = cast[DiagnosticAnalyzer](
                Activator.CreateInstance(
                    assembly.GetType("GSharp.InternalAnalyzers." + analyzerName, throwOnError: true)!!
                )
            )
            let corpusProject = CSharpProjectLoader.LoadInMemory(
                [](corpusName string, corpus string){(corpusName, corpus)}
            )
            Assert.True(corpusProject.BoundWithoutErrors, string.Join("\n", corpusProject.ErrorDiagnostics))
            return corpusProject
                .Compilation
                .WithAnalyzers(ImmutableArray.Create(analyzer!!))
                .GetAnalyzerDiagnosticsAsync()
                .GetAwaiter()
                .GetResult()
                .Where((d Microsoft.CodeAnalysis.Diagnostic) -> d.Id == "GSA0007")
                .Select(
                (d Microsoft.CodeAnalysis.Diagnostic) -> (
                    RoslynMember(d.Location) + ": " + d.GetMessage(CultureInfo.InvariantCulture)
                )
            )
                .OrderBy((m string) -> m, StringComparer.Ordinal)
                .ToList()
        }

        private func RoslynMember(location Microsoft.CodeAnalysis.Location) string {
            let node = location.SourceTree!!.GetRoot().FindNode(location.SourceSpan)
            for ancestor in node.AncestorsAndSelf() {
                switch ancestor {
                    case method is MethodDeclarationSyntax {
                        return method.Identifier.ValueText
                    }
                    case property is Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax {
                        return property.Identifier.ValueText
                    }
                    case VariableDeclaratorSyntax{
                        Parent: {Parent: Microsoft.CodeAnalysis.CSharp.Syntax.FieldDeclarationSyntax}
                    } field {
                        return field.Identifier.ValueText
                    }
                }
            }
            return "?"
        }

        private func GSharpMember(tree GSharp.Core.CodeAnalysis.Syntax.SyntaxTree, span TextSpan) string {
            // The innermost function or property declaration whose span covers
            // the diagnostic.
            var name = "?"
            var current GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SyntaxNode? = cast[GSharp.Core.CodeAnalysis.Syntax.SyntaxNode](tree.Root)
            while current != nil {
                switch current {
                    case function is FunctionDeclarationSyntax {
                        name = function.Identifier.Text
                    }
                    case property is GSharp.Core.CodeAnalysis.Syntax.PropertyDeclarationSyntax {
                        name = property.Identifier.Text
                    }
                    case field is GSharp.Core.CodeAnalysis.Syntax.FieldDeclarationSyntax {
                        name = field.Identifier.Text
                    }
                }
                current = current.GetChildren().FirstOrDefault(
                    (child GSharp.Core.CodeAnalysis.Syntax.SyntaxNode) -> child
                        .Span
                        .Start <= span.Start &&
                        span.Start +
                        span.Length <= child
                        .Span
                        .Start +
                        child
                        .Span
                        .Length
                )
            }
            return name
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
