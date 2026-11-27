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
    @Theory
    @InlineData(true)
    @InlineData(false)
    func ConditionalStaticExtensionHelperPreservesSymbols(supported bool) {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Helper.cs", ConditionalHelperSource)}
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator(){SupportsScopedConditionalSymbols = supported}.TranslateDocument(
                document,
                context
            )
        )
        if supported {
            Assert.Empty(
                context.Diagnostics.Where(
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
                )
            )
            Assert.Contains("@file:DefineSymbol(\"ACTIVE\")", printed, StringComparison.Ordinal)
        } else {
            let diagnostic = Assert.Single(
                context.Diagnostics.Where(
                    (
                        item TranslationDiagnostic
                    ) -> item.DiagnosticId == CSharpToGSharpTranslator.ConditionalSymbolsDiagnosticId
                )
            )
            Assert.True(diagnostic.IsUnsupported)
            Assert.NotNull(diagnostic.Location)
            Assert.DoesNotContain("@file:DefineSymbol", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func ConditionalStaticExtensionHelperMatchesNativeEffects() {
        Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(
            ConditionalHelperSource,
            expectedOutput: "2:1:1"
        )
    }

    @Fact
    func MergedOutputIgnoresUnrelatedCallsInAContributingFile() {
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("A.cs", `
#define ACTIVE
using System.Diagnostics;
public static partial class P {
    [Conditional("ACTIVE")] public static void Report() { }
    public static void A() { Report(); }
}
`), ("B.cs", `
#undef ACTIVE
public static partial class P { public static void B() { } }
public static class Q { public static void Run() { P.Report(); } }
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        Assert.Equal(2, project.Documents.Count)
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator(preservePartialParts: false){
                    SupportsScopedConditionalSymbols = true
                }.TranslateDocument(document, context)
            )
            Assert.Empty(
                context.Diagnostics.Where(
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
                )
            )
            if document.FilePath.EndsWith("A.cs", StringComparison.Ordinal) {
                Assert.Contains("@file:DefineSymbol(\"ACTIVE\")", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("class Q", printed, StringComparison.Ordinal)
            } else {
                Assert.Contains("@file:UndefineSymbol(\"ACTIVE\")", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("class P", printed, StringComparison.Ordinal)
            }
        }
    }

    @Fact
    func PackageOutputIgnoresCallsInAnotherNamespace() {
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Split.cs", `
#define ACTIVE
using System.Diagnostics;
namespace First { public static class P { public static int Value() => 1; } }
namespace Second {
    public static class Q {
        [Conditional("ACTIVE")] static void Report() { }
        public static void Run() { Report(); }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        for packageName in[]string{"First", "Second"} {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator(packageFilter: packageName, includeGlobalNamespace: false){
                    SupportsScopedConditionalSymbols = packageName == "Second"
                }.TranslateDocument(document, context)
            )
            Assert.Empty(
                context.Diagnostics.Where(
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
                )
            )
            if packageName == "Second" {
                Assert.Contains("@file:DefineSymbol(\"ACTIVE\")", printed, StringComparison.Ordinal)
            } else {
                Assert.Contains("class P", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("@file:DefineSymbol", printed, StringComparison.Ordinal)
                Assert.DoesNotContain("class Q", printed, StringComparison.Ordinal)
            }
        }
    }

    @Fact
    func OwnedExtensionSymbolsFollowTheEmittedBody() {
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("A.cs", `
#undef ACTIVE
public class P { }
`), ("B.cs", `
#define ACTIVE
using System.Diagnostics;
public static class Extensions {
    [Conditional("ACTIVE")] public static void Report() { }
    public static void Log(this P receiver) { Report(); }
}
`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        Assert.Equal(2, project.Documents.Count)
        var emittedBodies = 0
        var symbolHeaders = 0
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(
                CSharpToGSharpTranslator(){SupportsScopedConditionalSymbols = true}.TranslateDocument(document, context)
            )
            Assert.Empty(
                context.Diagnostics.Where(
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity != TranslationSeverity.Info
                )
            )
            let ownsBody = printed.Contains(" Log(", StringComparison.Ordinal)
            let definesSymbol = printed.Contains("@file:DefineSymbol(\"ACTIVE\")", StringComparison.Ordinal)
            Assert.Equal(ownsBody, definesSymbol)
            if ownsBody {
                emittedBodies++
            }
            if definesSymbol {
                symbolHeaders++
            }
        }
        Assert.Equal(1, emittedBodies)
        Assert.Equal(1, symbolHeaders)
    }

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
        private const ConditionalHelperSource string = `
#define ACTIVE
#nullable enable
using System.Diagnostics;
public sealed class Receiver { }
public static class Extensions {
    [Conditional("ACTIVE")]
    public static unsafe void Log(this Receiver receiver, int* value) { Demo.Calls++; }
}
public static unsafe class Demo {
    public static int Calls;
    static int receivers, arguments;
    static Receiver? Make(bool present) { receivers++; return present ? new Receiver() : null; }
    static int* Argument() { arguments++; return default(int*); }
    public static string Run() {
        Make(false)?.Log(Argument());
        Make(true)?.Log(Argument());
        return receivers + ":" + arguments + ":" + Calls;
    }
}
`

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
