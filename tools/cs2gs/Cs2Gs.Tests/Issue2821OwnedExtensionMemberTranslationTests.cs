// <copyright file="Issue2821OwnedExtensionMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue2821OwnedExtensionMemberTranslationTests
{
    [Fact]
    public void OwnedStructInstanceMethods_StayInsideTypeBody()
    {
        string printed = TranslateFiles(
            ("Value.cs", @"
namespace Demo;

public readonly record struct Value(int Number)
{
    public int Double() => Number * 2;

    public override string ToString() => Number.ToString();
}"))["Value.cs"];

        Assert.Contains("data struct Value", printed);
        Assert.Contains("    func Double()", printed);
        Assert.Contains("    override func ToString()", printed);
        Assert.DoesNotContain("func (self Value)", printed);
        Assert.DoesNotContain("func (self Value) ToString", printed);
    }

    [Fact]
    public void SamePackageExtension_OnSplitPartialType_MovesIntoOwnedType()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("A.Target.cs", @"
namespace Demo;

public partial class Meter
{
    public int Value;
}"),
            ("B.Target.cs", @"
namespace Demo;

public partial class Meter
{
    public int Double() => Value * 2;
}"),
            ("Extensions.cs", @"
using System;

namespace Demo;

public static class MeterExtensions
{
    public static int Adjust(this Meter meter) =>
        meter.Value >= 0 ? meter.Value : throw new InvalidOperationException();
}"));

        string combined = string.Join(Environment.NewLine, printed.Values);
        string target = Assert.Single(printed.Values, text => text.Contains("class Meter", StringComparison.Ordinal));

        Assert.Equal(1, CountOccurrences(combined, "func Adjust("));
        Assert.Contains("import System", target);
        Assert.Contains("    func Adjust()", target);
        Assert.Contains("var meter = this", target);
        Assert.DoesNotContain("func (meter Meter) Adjust", combined);
        Assert.DoesNotContain("class MeterExtensions", combined);
    }

    [Fact]
    public void ExternalReceiver_RetainsReceiverClause()
    {
        string printed = TranslateFiles(
            ("Extensions.cs", @"
namespace Demo;

public static class TextExtensions
{
    public static int TwiceLength(this string value) => value.Length * 2;
}"))["Extensions.cs"];

        Assert.Contains("func (value string) TwiceLength()", printed);
    }

    [Fact]
    public void ExcludedGeneratedExtension_DoesNotMoveIntoRetainedTarget()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            new CSharpToGSharpTranslator(retainedFilePaths: new[] { "Target.cs" }),
            ("Target.cs", @"
namespace Demo;

public partial class Meter
{
    public int Value;
}"),
            ("GeneratedExtensions.cs", @"
namespace Demo;

public static class MeterExtensions
{
    public static int Adjust(this Meter meter) => meter.Value;
}"));

        Assert.DoesNotContain("func Adjust(", printed["Target.cs"]);
    }

    private static IReadOnlyDictionary<string, string> TranslateFiles(
        params (string FileName, string Source)[] files)
    {
        return TranslateFiles(new CSharpToGSharpTranslator(), files);
    }

    private static IReadOnlyDictionary<string, string> TranslateFiles(
        CSharpToGSharpTranslator translator,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            string printed = GSharpPrinter.Print(unit);
            RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
            Assert.True(
                roundTrip.Success,
                "Translated G# must round-trip. Errors:\n" +
                    string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
            Assert.DoesNotContain(
                roundTrip.Errors,
                error => error.Contains("GS0314", StringComparison.Ordinal));
            result.Add(document.FilePath, printed);
        }

        return result;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }
}
