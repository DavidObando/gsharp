// <copyright file="Issue3685CovariantArrayConversionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3685 (the `InternalAnalyzers.Tests` self-migration wall): C#
/// array covariance is IMPLICIT — `AnalyzerTestHelper.GetReferences`
/// returns a `PortableExecutableReference[]` from a method declared
/// `MetadataReference[]` — while G# slices are invariant by design (gsc
/// issue #2516), so the bare operand is rejected (GS0155 pre-fix, GS0156 now).
/// The upcast is therefore spelled as the identity-preserving checked reference
/// cast `cast[[]Base](expr)` at the same argument / assignment / return /
/// local-initializer positions where `CoercePointerConversion` spells C#'s
/// implicit pointer conversions.
open class Issue3685CovariantArrayConversionTranslationTests {
    @Fact
    func ImplicitCovariantArray_Return_EmitsExplicitCast() {
        // The wall's exact shape: a LINQ `ToArray()` of the DERIVED element
        // returned from a method declared with the BASE element.
        let rendered = Render(`
using System.IO;
using System.Linq;

namespace Corpus.Issue3685
{
    public static class Holder
    {
        public static FileSystemInfo[] All(string[] names)
        {
            return names.Select(n => new DirectoryInfo(n)).ToArray();
        }
    }
}
`)
        Assert.Contains("cast[[]FileSystemInfo](", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitCovariantArray_Argument_EmitsExplicitCast() {
        let rendered = Render(`
using System.IO;

namespace Corpus.Issue3685
{
    public static class Holder
    {
        public static void Sink(FileSystemInfo[] infos) { }

        public static void Pass(DirectoryInfo[] dirs)
        {
            Sink(dirs);
        }
    }
}
`)
        Assert.Contains("Sink(cast[[]FileSystemInfo](dirs))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitCovariantArray_LocalInitializerAndAssignment_EmitExplicitCast() {
        let rendered = Render(`
using System.IO;

namespace Corpus.Issue3685
{
    public static class Holder
    {
        public static void Store(DirectoryInfo[] dirs)
        {
            FileSystemInfo[] first = dirs;
            first = dirs;
        }
    }
}
`)
        Assert.Contains("first []FileSystemInfo = cast[[]FileSystemInfo](dirs)", rendered, StringComparison.Ordinal)
        Assert.Contains("first = cast[[]FileSystemInfo](dirs)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SameElementArrayArgument_IsNotWrapped() {
        // No conversion happens, so the argument must stay bare — the guard that
        // keeps the cast off every array-typed expression in the corpus.
        let rendered = Render(`
using System.IO;

namespace Corpus.Issue3685
{
    public static class Holder
    {
        public static void Sink(FileSystemInfo[] infos) { }

        public static void Pass(FileSystemInfo[] infos)
        {
            Sink(infos);
        }
    }
}
`)
        Assert.Contains("Sink(infos)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("cast[", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ValueElementArrayArgument_IsNotWrapped() {
        // Value elements have no CLR array covariance at all; `int[] -> object[]`
        // is not a conversion C# performs, and an `int[]` flowing into an
        // `int[]`-typed slot must not acquire a cast either.
        let rendered = Render(`
namespace Corpus.Issue3685
{
    public static class Holder
    {
        public static void Sink(int[] values) { }

        public static void Pass(int[] values)
        {
            Sink(values);
        }
    }
}
`)
        Assert.Contains("Sink(values)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("cast[", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
