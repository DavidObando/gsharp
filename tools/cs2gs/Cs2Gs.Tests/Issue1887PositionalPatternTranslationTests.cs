// <copyright file="Issue1887PositionalPatternTranslationTests.cs" company="GSharp">
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
/// Issue #1887: a positional pattern (<c>p is (0, 0)</c>,
/// <c>p switch { (0, 0) => … }</c>) was silently dropped — the recursive
/// pattern translation only looped over <c>RecursivePatternSyntax
/// .PropertyPatternClause</c>, never <c>.PositionalPatternClause</c>, so every
/// positional subpattern vanished with no diagnostic and every arm became a
/// match-anything <c>case { }</c>.
/// <para>
/// G# has no positional-pattern syntax, but a positional subpattern reads the
/// exact same members a property subpattern would (a tuple's <c>Item1</c>/
/// <c>Item2</c>, or a record's positional property via its compiler-
/// synthesized <c>Deconstruct</c>), so it now lowers to that same nested
/// member-access form instead of being dropped.
/// </para>
/// </summary>
public class Issue1887PositionalPatternTranslationTests
{
    [Fact]
    public void IsPattern_BareTuplePositionalPattern_LowersToItemMemberTests()
    {
        // `origin is (0, 0)` against a `(int, int)` tuple must NOT become
        // `origin != nil` (the silent-drop bug) — it must test both Item1 AND
        // Item2.
        string rendered = Render(@"
namespace Corpus.Issue1887
{
    public class Holder
    {
        public bool IsOrigin((int, int) origin)
        {
            return origin is (0, 0);
        }
    }
}
");

        Assert.Contains("origin.Item1 == 0", rendered, StringComparison.Ordinal);
        Assert.Contains("origin.Item2 == 0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_TypedRecordPositionalPattern_LowersToPropertyMemberTests()
    {
        // `p is Point(0, 0)` against a record: the positional subpatterns bind
        // through the record's compiler-synthesized `Deconstruct`, whose
        // out-parameter names match the record's positional properties (X, Y).
        string rendered = Render(@"
namespace Corpus.Issue1887
{
    public record Point(int X, int Y);

    public class Holder
    {
        public bool IsOrigin(Point p)
        {
            return p is Point(0, 0);
        }
    }
}
");

        Assert.Contains("p.X == 0", rendered, StringComparison.Ordinal);
        Assert.Contains("p.Y == 0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_BarePositionalPatternArms_LowerToPropertyPatternArms()
    {
        // The issue's motivating example: every arm of `p switch { (0,0) =>
        // …, (0,_) => …, (>0,>0) => …, _ => … }` must keep its own positional
        // subpatterns (constant, discard, relational) instead of collapsing to
        // an identical match-anything `case { }` in every arm.
        string rendered = Render(@"
namespace Corpus.Issue1887
{
    public record Point(int X, int Y);

    public class Holder
    {
        public string Describe(Point p)
        {
            return p switch
            {
                (0, 0) => ""origin"",
                (0, _) => ""y-axis"",
                ( > 0, > 0) => ""ne"",
                _ => ""other"",
            };
        }
    }
}
");

        Assert.Contains("case { X: 0, Y: 0 }", rendered, StringComparison.Ordinal);
        Assert.Contains("case { X: 0 }", rendered, StringComparison.Ordinal);
        Assert.Contains("case { X: > 0, Y: > 0 }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("case { }:", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchStatement_ThreeArityTuplePositionalPattern_LowersToNestedItemTests()
    {
        // Arity > 2: `(0, 0, 5)` must keep all three positions, not just drop
        // to a bare tuple-null check.
        string rendered = Render(@"
namespace Corpus.Issue1887
{
    public class Holder
    {
        public bool Classify((int, int, int) triple)
        {
            switch (triple)
            {
                case (0, 0, 5):
                    return true;
                default:
                    return false;
            }
        }
    }
}
");

        Assert.Contains("Item1: 0", rendered, StringComparison.Ordinal);
        Assert.Contains("Item2: 0", rendered, StringComparison.Ordinal);
        Assert.Contains("Item3: 5", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_UserDeconstructWithUnrelatedParameterNames_ReportsDiagnosticInsteadOfSilentDrop()
    {
        // A hand-written `Deconstruct` whose out-parameter names have no
        // matching property on the type has no canonical G# member to bind
        // the positional subpattern to; this must be reported LOUDLY (ADR-0115
        // §B), never silently dropped to a match-anything test.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Source.cs", @"
namespace Corpus.Issue1887
{
    public class Opaque
    {
        public void Deconstruct(out int a, out int b)
        {
            a = 1;
            b = 2;
        }
    }

    public class Holder
    {
        public bool Test(Opaque o)
        {
            return o is (1, 2);
        }
    }
}
"),
        });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);

        Assert.NotEmpty(context.Diagnostics);
        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("positional subpattern has no canonical G# form", StringComparison.Ordinal));
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
        return GSharpPrinter.Print(unit);
    }
}
