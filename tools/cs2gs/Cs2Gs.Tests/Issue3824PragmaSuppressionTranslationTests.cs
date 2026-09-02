// <copyright file="Issue3824PragmaSuppressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issues #3820 / #3824, ADR-0175: a C# <c>#pragma warning disable GSA####</c>
/// region covering a declaration translates to an
/// <c>@SuppressDiagnostic("GSA####")</c> annotation on the migrated
/// declaration. Identifier families that name analyzers which do not run on G#
/// (StyleCop <c>SA</c>, the C# compiler <c>CS</c>, the Roslyn ecosystem
/// <c>CA</c>/<c>IDE</c>/<c>VSTHRD</c>/<c>RS</c>) are dropped, not carried.
/// </summary>
public class Issue3824PragmaSuppressionTranslationTests
{
    [Fact]
    public void GsaPragmaRegion_BecomesSuppressDiagnosticOnTheCoveredMethod()
    {
        const string source = @"
public class Rewriter
{
    public int Untouched() => 1;

#pragma warning disable GSA0005
    public int Suppressed() => 2;
#pragma warning restore GSA0005

    public int AlsoUntouched() => 3;
}
";

        string printed = Translate(source);

        Assert.Contains("@SuppressDiagnostic(\"GSA0005\")", printed, StringComparison.Ordinal);

        // Scoping proof at the translator level: exactly ONE annotation is
        // emitted, on the one method the C# region covered. A file- or
        // project-level bridge would produce zero here and suppress everything.
        Assert.Equal(1, CountOccurrences(printed, "@SuppressDiagnostic"));

        int annotation = printed.IndexOf("@SuppressDiagnostic", StringComparison.Ordinal);
        int suppressed = printed.IndexOf("Suppressed", StringComparison.Ordinal);
        int alsoUntouched = printed.IndexOf("AlsoUntouched", StringComparison.Ordinal);
        Assert.True(annotation < suppressed, "annotation must precede the method it covers");
        Assert.True(suppressed < alsoUntouched, "the following method must be unannotated");
    }

    [Fact]
    public void MultipleRegions_EachAnnotateTheirOwnMethod()
    {
        const string source = @"
public class Rewriter
{
#pragma warning disable GSA0005
    public int First() => 1;
#pragma warning restore GSA0005

    public int Middle() => 2;

#pragma warning disable GSA0005
    public int Second() => 3;
#pragma warning restore GSA0005
}
";

        string printed = Translate(source);

        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0005\")"));
    }

    [Fact]
    public void NonGsaPragmas_AreDropped()
    {
        const string source = @"
public class Sample
{
#pragma warning disable SA1600, CS1591, CA1822, IDE0060, RS2008
    public int Documented() => 1;
#pragma warning restore SA1600, CS1591, CA1822, IDE0060, RS2008
}
";

        string printed = Translate(source);

        Assert.DoesNotContain("@SuppressDiagnostic", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MixedRegion_CarriesOnlyTheGsaIdentifier()
    {
        const string source = @"
public class Sample
{
#pragma warning disable SA1600, GSA0005, CS1591
    public int Mixed() => 1;
#pragma warning restore SA1600, GSA0005, CS1591
}
";

        string printed = Translate(source);

        Assert.Contains("@SuppressDiagnostic(\"GSA0005\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("SA1600", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("CS1591", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void FileWideRegion_AnnotatesEveryCoveredMethod()
    {
        const string source = @"
#pragma warning disable GSA0005
public class Sample
{
    public int A() => 1;

    public int B() => 2;
}
#pragma warning restore GSA0005
";

        string printed = Translate(source);

        Assert.Equal(2, CountOccurrences(printed, "@SuppressDiagnostic(\"GSA0005\")"));
    }

    [Fact]
    public void TranslatedSuppression_BindsInTheMigratedTree()
    {
        const string source = @"
public class Rewriter
{
#pragma warning disable GSA0005
    public int Suppressed() => 2;
#pragma warning restore GSA0005
}
";

        string printed = Translate(source);

        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Program.cs", source) });

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
