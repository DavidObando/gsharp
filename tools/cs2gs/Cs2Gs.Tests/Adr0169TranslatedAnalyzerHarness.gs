// <copyright file="Adr0169TranslatedAnalyzerHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
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
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text

/// Shared plumbing for the ADR-0169 parity and snippet-migration tests:
/// translates the REAL GSA0001 source in analyzer mode and compiles it with
/// the real G# compiler into a loadable analyzer assembly.
internal shared class Adr0169TranslatedAnalyzerHarness {
    /// A minimal stand-in for the analyzer project's descriptor table.
    const Gsa0001Descriptors string = `
using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

public static class DiagnosticDescriptors
{
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        "GSA0001", "T", "M", "GSharp.InternalAnalyzers", DiagnosticSeverity.Warning, isEnabledByDefault: true);
}
`

    /// Issue #3880: builds the parity tests' ROSLYN control by compiling one
    /// real analyzer's own C# source with Roslyn and instantiating it out of
    /// the emitted assembly, instead of naming the type from a project
    /// reference on `src/Analyzers/InternalAnalyzers`.
    ///
    /// The project reference does not survive self-migration: cs2gs retargets
    /// `InternalAnalyzers` onto the G# analyzer API (ADR-0169), so the
    /// migrated `StructFieldDefsReadAnalyzer` is a
    /// `GSharpDiagnosticAnalyzer` and
    /// `ImmutableArray.Create[DiagnosticAnalyzer](StructFieldDefsReadAnalyzer())`
    /// has no applicable overload — the whole Roslyn half of the parity check
    /// stops binding. Compiling the analyzer's source is also the more honest
    /// control: it is exactly what the G# half already does (translate and
    /// compile the same file), so both sides now start from the same bytes on
    /// disk rather than one side starting from a build output.
    /// @param analyzerFileName The analyzer source file name under `src/Analyzers/InternalAnalyzers`.
    /// @param analyzerTypeName The analyzer type's simple name.
    /// @returns A live Roslyn analyzer instance.
    func CompileRoslynAnalyzer(analyzerFileName string, analyzerTypeName string) DiagnosticAnalyzer? {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                (analyzerFileName, FrozenCompilerSnapshots.Analyzer(analyzerFileName)),
                ("DiagnosticDescriptors.cs", FrozenCompilerSnapshots.Analyzer("DiagnosticDescriptors.cs"))
            }
        )
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let peStream = MemoryStream()
        let emitResult = project.Compilation.Emit(peStream)
        Assert.True(emitResult.Success, (`Roslyn control analyzer ` + "$analyzerTypeName" + ` should compile:
`) + string.Join(
                "\n",
                emitResult.Diagnostics.Where(
                    (d Microsoft.CodeAnalysis.Diagnostic) -> d.Severity == Microsoft
                        .CodeAnalysis
                        .DiagnosticSeverity
                        .Error
                )
            ))
        let assembly = Assembly.Load(peStream.ToArray())
        let analyzerType Type? = assembly.GetType("GSharp.InternalAnalyzers." + analyzerTypeName, throwOnError: true)
        return cast[DiagnosticAnalyzer](Activator.CreateInstance(analyzerType!!))
    }

    /// Translates and compiles the real GSA0001 into an analyzer assembly.
    /// @param workDirectory The directory receiving the emitted dll.
    /// @returns The analyzer assembly path.
    func CompileTranslatedGsa0001(workDirectory string) string -> CompileTranslatedAnalyzer(
        workDirectory,
        "StructFieldDefsReadAnalyzer.cs",
        "TranslatedGsa0001",
        Gsa0001Descriptors
    )

    /// Translates and compiles one REAL analyzer from
    /// `src/Analyzers/InternalAnalyzers` into an analyzer assembly, using
    /// the repository's own `DiagnosticDescriptors.cs` unless a stand-in
    /// is supplied. Generalized for issue #3794 so GSA0003 and GSA0004 — the
    /// two namespace-scoped rules whose migrated tests the snippet
    /// package-split fixes — can be executed here, not merely translated.
    /// @param workDirectory The directory receiving the emitted dll.
    /// @param analyzerFileName The analyzer source file name.
    /// @param assemblyName The emitted assembly name.
    /// @param descriptorSource A descriptor stand-in, or null for the real table.
    /// @returns The analyzer assembly path.
    func CompileTranslatedAnalyzer(
        workDirectory string,
        analyzerFileName string,
        assemblyName string,
        descriptorSource string? = nil
    ) string {
        let analyzerSource = FrozenCompilerSnapshots.Analyzer(analyzerFileName)
        let descriptors = descriptorSource ?? FrozenCompilerSnapshots.Analyzer("DiagnosticDescriptors.cs")
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){(analyzerFileName, analyzerSource), ("DiagnosticDescriptors.cs", descriptors)}
        )
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        Assert.True(AnalyzerProjectDetector.IsAnalyzerProject(project.Compilation))
        let translator = CSharpToGSharpTranslator(analyzerApiMode: true)
        let trees = List[GSharp.Core.CodeAnalysis.Syntax.SyntaxTree]()
        for document in project.Documents.Where(
            (d LoadedDocument) -> Path.GetFileName(d.FilePath) != "GlobalUsings.cs"
        ) {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
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
            .Compilation(resolver, trees.ToArray()){IsLibrary = true, AssemblyName = assemblyName}
        let dllPath = Path.Combine(workDirectory, assemblyName + ".dll")
        {
            using let peStream = File.Create(dllPath)
            let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            Assert.True(result.Success, (`Translated ` + "$assemblyName" + ` should compile:
`) + string.Join(
                    "\n",
                    result
                        .Diagnostics
                        .Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
                        .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message)
                ))
        }
        return dllPath
    }

    /// Walks up from the test base directory to the repository root.
    /// @returns The repo root path.
    func FindRepoRoot() string -> TestFixtureSource.Root
}
