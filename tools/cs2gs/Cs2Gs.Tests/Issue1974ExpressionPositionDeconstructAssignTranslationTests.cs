// <copyright file="Issue1974ExpressionPositionDeconstructAssignTranslationTests.cs" company="GSharp">
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
/// Issue #1974: a C# deconstruction-ASSIGNMENT used in EXPRESSION position
/// (<c>var r = (x, y) = (1, 2);</c>, <c>M((a, b) = (1, 2))</c>, a chained
/// <c>x = (a, b) = (1, 2);</c>, ...) — not just the bare-statement form
/// (<c>(x, y) = (1, 2);</c>) already handled by issue #1895 — was not
/// hoisted at all: only the <c>ExpressionStatement</c> wrapper was
/// recognized, so a deconstruction assignment anywhere else in an
/// expression tree fell through untranslated.
///
/// The fix reuses the same value-position-assignment hoisting seam that
/// already handles a scalar assignment used as a value (issue #1723): the
/// deconstruction assignment is lowered exactly like the statement form
/// (one native <c>let (t0, t1, ...) = rhs</c> spill per nesting level, plus
/// per-element assignments), except EVERY element — including a discard —
/// is captured in a real temp, and the expression's value becomes a tuple
/// literal over those temps (the same value C# itself produces). A
/// deconstruction assignment that introduces a NEW local (<c>(x, var y) =
/// ...</c>) is only legal C# as a bare statement (CS8185 otherwise), so that
/// mixed form is unreachable in expression position and stays covered by the
/// statement-form tests in <see cref="Issue1895DeconstructAssignTranslationTests"/>.
/// </summary>
public class Issue1974ExpressionPositionDeconstructAssignTranslationTests
{
    [Fact]
    public void LocalInitializer_FromDeconstructAssign_HoistsThenReadsTupleValue()
    {
        string rendered = Render(@"
namespace Corpus.Issue1974
{
    public class Holder
    {
        public void M()
        {
            int x = 0;
            int y = 0;
            var r = (x, y) = (1, 2);
            System.Console.WriteLine(r.Item1 + r.Item2);
        }
    }
}
");

        Assert.Contains("let (__decon0, __decon1) = (1, 2)", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("y = __decon1", rendered, StringComparison.Ordinal);
        Assert.Contains("let r = (__decon0, __decon1)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ArgumentPosition_DeconstructAssign_HoistsBeforeCall()
    {
        string rendered = Render(@"
namespace Corpus.Issue1974
{
    public class Holder
    {
        public void Accept<T>(T t)
        {
        }

        public void M()
        {
            int x = 0;
            int y = 0;
            Accept((x, y) = (1, 2));
        }
    }
}
");

        Assert.Contains("let (__decon0, __decon1) = (1, 2)", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("y = __decon1", rendered, StringComparison.Ordinal);
        Assert.Contains("Accept((__decon0, __decon1))", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ChainedAssignment_OuterTargetReadsDeconstructAssignValue()
    {
        // `x = (a, b) = (1, 2);`: the outer `x` is written the tuple VALUE
        // produced by the inner deconstruction assignment.
        string rendered = Render(@"
namespace Corpus.Issue1974
{
    public class Holder
    {
        public void M()
        {
            int a = 0;
            int b = 0;
            var x = (0, 0);
            x = (a, b) = (1, 2);
            System.Console.WriteLine(x.Item1 + x.Item2);
        }
    }
}
");

        Assert.Contains("let (__decon0, __decon1) = (1, 2)", rendered, StringComparison.Ordinal);
        Assert.Contains("a = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("b = __decon1", rendered, StringComparison.Ordinal);
        Assert.Contains("x = (__decon0, __decon1)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DiscardTarget_InExpressionPosition_StillCapturesValueInRealTemp()
    {
        // Unlike the statement form (issue #1895), a discard here still
        // needs a real temp: its value feeds the deconstruction assignment's
        // own result.
        string rendered = Render(@"
namespace Corpus.Issue1974
{
    public class Holder
    {
        public void M()
        {
            int x = 0;
            var r = (x, _) = (1, 2);
            System.Console.WriteLine(x + r.Item2);
        }
    }
}
");

        Assert.Contains("let (__decon0, __decon1) = (1, 2)", rendered, StringComparison.Ordinal);
        Assert.Contains("x = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("let r = (__decon0, __decon1)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("(__decon0, _)", rendered, StringComparison.Ordinal);

        // Issue #2099: the discard still gets a real temp to feed the
        // expression's value, but `_` isn't a real assignable location — no
        // stray `_ = __decon1;` write-back should be emitted for it.
        Assert.DoesNotContain("_ = __decon", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NestedTarget_InExpressionPosition_ReadsBackNestedTupleValue()
    {
        // `((a, b), c) = ...` used as a value: the nested arm's value is
        // rebuilt as its own nested tuple literal (issue #1974 generalizes
        // the nested-target support added for the statement form).
        string rendered = Render(@"
namespace Corpus.Issue1974
{
    public class Holder
    {
        public void M()
        {
            int a = 0;
            int b = 0;
            int c = 0;
            var r = ((a, b), c) = ((1, 2), 3);
            System.Console.WriteLine(a + b + c + r.Item2);
        }
    }
}
");

        Assert.Contains("let (__decon0, __decon1) = ((1, 2), 3)", rendered, StringComparison.Ordinal);
        Assert.Contains("let (__decon2, __decon3) = __decon0", rendered, StringComparison.Ordinal);
        Assert.Contains("a = __decon2", rendered, StringComparison.Ordinal);
        Assert.Contains("b = __decon3", rendered, StringComparison.Ordinal);
        Assert.Contains("c = __decon1", rendered, StringComparison.Ordinal);
        Assert.Contains("let r = ((__decon2, __decon3), __decon1)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NonIdentifierTarget_InExpressionPosition_NowLowersWithoutGap()
    {
        // Issue #2234 generalizes the #1895/#1974 lowering to element/member-
        // access targets reached via the value-position hoisting seam too:
        // `arr`/`i` are captured into temps before the RHS is spilled.
        string rendered = Render(@"
namespace Corpus.Issue1974
{
    public class Holder
    {
        public void M()
        {
            int[] arr = new int[2];
            int i = 0;
            int y = 1;
            var r = (arr[i], y) = (2, 3);
            System.Console.WriteLine(arr[0] + y + r.Item2);
        }
    }
}
");
        AssertRoundTripParses(rendered);
        Assert.Contains("arr[i]", rendered);
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
