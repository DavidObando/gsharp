// <copyright file="Issue1891ExtPropPatternTranslationTests.cs" company="GSharp">
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
/// Issue #1891: an extended property subpattern (a nested member access in a
/// property subpattern, e.g. <c>{ Start.X: 0 }</c>) parses as
/// <c>ExpressionColon</c> rather than <c>NameColon</c>. The <c>is</c>-form
/// boolean-test lowering already handled this correctly (it lowers to a
/// nested member-access test, e.g. <c>receiver.Start.X == 0</c>). The
/// switch-arm G#-pattern lowering only recognized <c>NameColon</c> and
/// misreported the subpattern as an unsupported *positional* subpattern. G#'s
/// property-pattern field is a single identifier (no dotted form), so the
/// switch-arm fix nests <c>PropertyPattern</c>s instead: <c>Start.X: 0</c>
/// becomes <c>{ Start: { X: 0 } }</c>, to any chain depth.
/// </summary>
public class Issue1891ExtPropPatternTranslationTests
{
    private const string PointSource = @"
namespace Corpus.Issue1891
{
    public class Point
    {
        public int X;
        public int Y;
    }

    public class Segment
    {
        public Point Start;
        public int Length;
    }
";

    [Fact]
    public void SwitchExpression_ExtendedPropertySubpattern_LowersToNestedPropertyPattern()
    {
        string rendered = Render(PointSource + @"
    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0 } => ""zero"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ Start: { X: 0 } }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_DeepMemberChain_LowersToDeeplyNestedPropertyPattern()
    {
        string rendered = Render(@"
namespace Corpus.Issue1891
{
    public class C
    {
        public int Value;
    }

    public class B
    {
        public C C;
    }

    public class A
    {
        public B B;
    }

    public class Holder
    {
        public string Describe(A a) => a switch
        {
            { B.C.Value: 0 } => ""zero"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ B: { C: { Value: 0 } } }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_ExtendedSubpatternCombinedWithSimpleSubpattern_LowersBothFields()
    {
        string rendered = Render(PointSource + @"
    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0, Length: 1 } => ""match"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ Start: { X: 0 }, Length: 1 }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_ExtendedPropertySubpattern_StillLowersToNestedMemberAccessTest()
    {
        // Regression: the is-form path already handled ExpressionColon; the
        // switch-arm fix must not disturb it.
        string rendered = Render(PointSource + @"
    public class Holder
    {
        public bool Describe(Segment s)
        {
            if (s is { Start.X: 0 })
            {
                return true;
            }

            return false;
        }
    }
}
");

        Assert.Contains("s.Start.X == 0", rendered, StringComparison.Ordinal);
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
