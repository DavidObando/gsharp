// <copyright file="Issue6231ConditionalSymbolPreservationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import Xunit

open class Issue6231ConditionalSymbolPreservationTests {
    @Fact
    func ConditionalCallsPreserveDefinedAndUndefinedSymbolsInSortedFileAnnotations() {
        let result = Translate(true)
        Assert.Empty(
            result
                .Context
                .Diagnostics
                .Where((diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info)
        )
        Assert.Contains("@file:DefineSymbol(\"ALPHA\", \"ZETA\")", result.Printed, StringComparison.Ordinal)
        Assert.Contains("@file:UndefineSymbol(\"DEBUG\")", result.Printed, StringComparison.Ordinal)
        Assert.Equal(result.Printed, Translate(true).Printed)
    }

    @Fact
    func UnknownOrUnsupportedDestinationProducesAnExplicitDiagnostic() {
        let result = Translate(false)
        let diagnostic = Assert.Single(
            result
                .Context
                .Diagnostics
                .Where(
                (
                    item TranslationDiagnostic
                ) -> item.DiagnosticId == CSharpToGSharpTranslator.ConditionalSymbolsDiagnosticId
            )
        )
        Assert.True(diagnostic.IsUnsupported)
        Assert.NotNull(diagnostic.Location)
        Assert.DoesNotContain("@file:DefineSymbol", result.Printed, StringComparison.Ordinal)
    }

    @Fact
    func PartialFilesKeepOppositeEnvironmentsAndRejectAnUnsafeMerge() {
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("A.cs", `
#define ACTIVE
using System.Diagnostics;
public static partial class Demo {
    [Conditional("ACTIVE")] static void Report() { }
    public static void A() { Report(); }
}
`), ("B.cs", `
#undef ACTIVE
public static partial class Demo {
    public static void B() { Report(); }
}
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        Assert.Equal(2, project.Documents.Count)
        let separate = CSharpToGSharpTranslator(preservePartialParts: true){SupportsScopedConditionalSymbols = true}
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(separate.TranslateDocument(document, context))
            Assert.Empty(
                context.Diagnostics.Where(
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
                )
            )
            let expected = if document.FilePath.EndsWith("A.cs", StringComparison.Ordinal) {
                "@file:DefineSymbol(\"ACTIVE\")"
            } else {
                "@file:UndefineSymbol(\"ACTIVE\")"
            }
            Assert.Contains(expected, printed, StringComparison.Ordinal)
        }
        let primary = project.Documents.First(
            (document LoadedDocument) -> document.FilePath.EndsWith("A.cs", StringComparison.Ordinal)
        )
        let mergedContext = TranslationContext(project.Compilation, primary.SemanticModel, primary.FilePath)
        CSharpToGSharpTranslator(preservePartialParts: false){
            SupportsScopedConditionalSymbols = true
        }.TranslateDocument(primary, mergedContext)
        Assert.Contains(
            mergedContext.Diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.ConditionalSymbolsDiagnosticId &&
                diagnostic.IsUnsupported
        )
    }

    @Fact
    func CompilerCapabilityIsReadFromTheDestinationImage() {
        using let supported = File.OpenRead(typeof(GSharp.Core.CodeAnalysis.ConditionalSymbols).Assembly.Location)
        Assert.True(SdkCompilerCapabilities.HasScopedConditionalSymbols(supported))
        using let unsupported = File.OpenRead(typeof(Issue6231ConditionalSymbolPreservationTests).Assembly.Location)
        Assert.False(SdkCompilerCapabilities.HasScopedConditionalSymbols(unsupported))
        using let invalid = MemoryStream([]uint8{0, 1, 2, 3})
        Assert.False(SdkCompilerCapabilities.HasScopedConditionalSymbols(invalid))
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Marker.cs", `
namespace GSharp.Core.CodeAnalysis {
    internal static class ConditionalSymbols { }
}
`)})
        using let internalMarker = MemoryStream()
        let emitted = project.Compilation.Emit(internalMarker)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        internalMarker.Position = 0
        Assert.False(SdkCompilerCapabilities.HasScopedConditionalSymbols(internalMarker))
        Assert.False(SdkCompilerCapabilities.SupportsScopedConditionalSymbols("Release", "0.0.0-unavailable-6231"))
    }

    shared {
        private func Translate(supported bool)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Symbols.cs", `
#define ZETA
#define ALPHA
#undef DEBUG
using System;
using System.Diagnostics;
public static class Demo
{
    [Conditional("ZETA"), Conditional("ALPHA")]
    static void Keep() { }
    [Conditional("DEBUG")]
    static void Skip() { }
    public static readonly Action Field = () => { Keep(); Skip(); };
    public static Action Create() => () => { Keep(); Skip(); };
    public static void Run() { Keep(); Skip(); }
}
`)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translator = CSharpToGSharpTranslator(){SupportsScopedConditionalSymbols = supported}
            return (GSharpPrinter.Print(translator.TranslateDocument(document, context)), context)
        }
    }
}
