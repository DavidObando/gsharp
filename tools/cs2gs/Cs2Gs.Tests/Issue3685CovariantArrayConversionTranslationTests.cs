// <copyright file="Issue3685CovariantArrayConversionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3685 (the <c>InternalAnalyzers.Tests</c> self-migration wall): C#
/// array covariance is IMPLICIT — <c>AnalyzerTestHelper.GetReferences</c>
/// returns a <c>PortableExecutableReference[]</c> from a method declared
/// <c>MetadataReference[]</c> — while G# slices are invariant by design (gsc
/// issue #2516), so the bare operand is rejected (GS0155 pre-fix, GS0156 now).
/// The upcast is therefore spelled as the identity-preserving checked reference
/// cast <c>cast[[]Base](expr)</c> at the same argument / assignment / return /
/// local-initializer positions where <c>CoercePointerConversion</c> spells C#'s
/// implicit pointer conversions.
/// </summary>
public class Issue3685CovariantArrayConversionTranslationTests
{
    [Fact]
    public void ImplicitCovariantArray_Return_EmitsExplicitCast()
    {
        // The wall's exact shape: a LINQ `ToArray()` of the DERIVED element
        // returned from a method declared with the BASE element.
        string rendered = Render(@"
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
");

        Assert.Contains("cast[[]FileSystemInfo](", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitCovariantArray_Argument_EmitsExplicitCast()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("Sink(cast[[]FileSystemInfo](dirs))", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ImplicitCovariantArray_LocalInitializerAndAssignment_EmitExplicitCast()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("first []FileSystemInfo = cast[[]FileSystemInfo](dirs)", rendered, StringComparison.Ordinal);
        Assert.Contains("first = cast[[]FileSystemInfo](dirs)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SameElementArrayArgument_IsNotWrapped()
    {
        // No conversion happens, so the argument must stay bare — the guard that
        // keeps the cast off every array-typed expression in the corpus.
        string rendered = Render(@"
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
");

        Assert.Contains("Sink(infos)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ValueElementArrayArgument_IsNotWrapped()
    {
        // Value elements have no CLR array covariance at all; `int[] -> object[]`
        // is not a conversion C# performs, and an `int[]` flowing into an
        // `int[]`-typed slot must not acquire a cast either.
        string rendered = Render(@"
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
");

        Assert.Contains("Sink(values)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
