// <copyright file="Issue1889ListPatternTranslationTests.cs" company="GSharp">
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
/// Issue #1889: a C# list pattern (<c>ListPatternSyntax</c>) and its slice
/// ("rest") subpattern (<c>SlicePatternSyntax</c>) had no canonical G# form and
/// reported the CS2GS-GAP "is-pattern 'ListPattern' has no canonical G# form
/// yet". G# has a native list/slice pattern (spec §Pattern matching), so both
/// pattern-translation paths now emit it directly:
/// <list type="bullet">
/// <item>a top-level <c>is</c>-pattern (`x is [...]`) — G#'s <c>is</c> operator
/// only tests a type, so it lowers to a hand-composed boolean (a length test
/// ANDed with a per-element test), mirroring the existing property/positional
/// pattern lowering.</item>
/// <item>a switch-expression/statement arm (`case [...]:` / `case [...] {`) —
/// lowers directly to G#'s native <c>ListPattern</c>/<c>SlicePattern</c>, since
/// gsc's own pattern binder performs the length/element matching at runtime.</item>
/// </list>
/// </summary>
public class Issue1889ListPatternTranslationTests
{
    [Fact]
    public void IsPattern_ExactLengthConstantElements_LowersToLengthAndElementTests()
    {
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [1, 2, 3, 4])
            {
                return true;
            }

            return false;
        }
    }
}
");

        Assert.Contains("values.Length == 4", rendered, StringComparison.Ordinal);
        Assert.Contains("values[0] == 1", rendered, StringComparison.Ordinal);
        Assert.Contains("values[3] == 4", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_SliceInMiddle_LowersToMinLengthAndEdgeTests()
    {
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [1, .., 4])
            {
                return true;
            }

            return false;
        }
    }
}
");

        Assert.Contains("values.Length >= 2", rendered, StringComparison.Ordinal);
        Assert.Contains("values[0] == 1", rendered, StringComparison.Ordinal);
        Assert.Contains("values[values.Length - 1] == 4", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_ElementsAfterSlice_IndexFromEnd()
    {
        // The elements AFTER a slice must be indexed end-relative, not from the
        // front: `[1, .., 4, 5]` → last two are `^2`/`^1`, i.e. Length-2/Length-1.
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [1, .., 4, 5])
            {
                return true;
            }

            return false;
        }
    }
}
");

        Assert.Contains("values.Length >= 3", rendered, StringComparison.Ordinal);
        Assert.Contains("values[0] == 1", rendered, StringComparison.Ordinal);
        Assert.Contains("values[values.Length - 2] == 4", rendered, StringComparison.Ordinal);
        Assert.Contains("values[values.Length - 1] == 5", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_Empty_LowersToLengthZeroTest()
    {
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public bool Describe(int[] values)
        {
            if (values is [])
            {
                return true;
            }

            return false;
        }
    }
}
");

        Assert.Contains("values.Length == 0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_HeadAndRestBinders_BindHeadByIndexAndRestBySlice()
    {
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public int Describe(int[] values)
        {
            if (values is [var head, .. var rest])
            {
                return head + rest.Length;
            }

            return -1;
        }
    }
}
");

        Assert.Contains("values.Length >= 1", rendered, StringComparison.Ordinal);
        Assert.Contains("values[0] + values[1..].Length", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_ListPatternArms_LowerToNativeListAndSlicePatterns()
    {
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public string Describe(int[] values) => values switch
        {
            [] => ""empty"",
            [1, .., 4] => ""edges"",
            [var head, .. var rest] => $""{head}:{rest.Length}"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("case []:", rendered, StringComparison.Ordinal);
        Assert.Contains("case [1, .., 4]:", rendered, StringComparison.Ordinal);
        Assert.Contains("case [_, ..rest]:", rendered, StringComparison.Ordinal);
        Assert.Contains("\"${values[0]}:${rest.Length}\"", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchStatement_ListPatternArm_LowersToNativeListPattern()
    {
        string rendered = Render(@"
namespace Corpus.Issue1889
{
    public class Holder
    {
        public string Describe(int[] values)
        {
            switch (values)
            {
                case [1, .., 4]:
                    return ""edges"";
                default:
                    return ""other"";
            }
        }
    }
}
");

        Assert.Contains("case [1, .., 4] {", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
