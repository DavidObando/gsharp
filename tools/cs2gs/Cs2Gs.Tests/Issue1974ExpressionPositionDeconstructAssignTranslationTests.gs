// <copyright file="Issue1974ExpressionPositionDeconstructAssignTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1974: a C# deconstruction-ASSIGNMENT used in EXPRESSION position
/// (`var r = (x, y) = (1, 2);`, `M((a, b) = (1, 2))`, a chained
/// `x = (a, b) = (1, 2);`, ...) — not just the bare-statement form
/// (`(x, y) = (1, 2);`) already handled by issue #1895 — was not
/// hoisted at all: only the `ExpressionStatement` wrapper was
/// recognized, so a deconstruction assignment anywhere else in an
/// expression tree fell through untranslated.
///
/// The fix reuses the same value-position-assignment hoisting seam that
/// already handles a scalar assignment used as a value (issue #1723): the
/// deconstruction assignment is lowered exactly like the statement form
/// (one native `let (t0, t1, ...) = rhs` spill per nesting level, plus
/// per-element assignments), except EVERY element — including a discard —
/// is captured in a real temp, and the expression's value becomes a tuple
/// literal over those temps (the same value C# itself produces). A
/// deconstruction assignment that introduces a NEW local (`(x, var y) =
/// ...`) is only legal C# as a bare statement (CS8185 otherwise), so that
/// mixed form is unreachable in expression position and stays covered by the
/// statement-form tests in (cref:Issue1895DeconstructAssignTranslationTests).
open class Issue1974ExpressionPositionDeconstructAssignTranslationTests {
    @Fact
    func LocalInitializer_FromDeconstructAssign_HoistsThenReadsTupleValue() {
        let rendered = Render(`
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
`)
        Assert.Contains("let (xValue, yValue) = (1, 2)", rendered, StringComparison.Ordinal)
        Assert.Contains("x = xValue", rendered, StringComparison.Ordinal)
        Assert.Contains("y = yValue", rendered, StringComparison.Ordinal)
        Assert.Contains("let r = (xValue, yValue)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ArgumentPosition_DeconstructAssign_HoistsBeforeCall() {
        let rendered = Render(`
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
`)
        Assert.Contains("let (xValue, yValue) = (1, 2)", rendered, StringComparison.Ordinal)
        Assert.Contains("x = xValue", rendered, StringComparison.Ordinal)
        Assert.Contains("y = yValue", rendered, StringComparison.Ordinal)
        Assert.Contains("Accept((xValue, yValue))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ChainedAssignment_OuterTargetReadsDeconstructAssignValue() {
        // `x = (a, b) = (1, 2);`: the outer `x` is written the tuple VALUE
        // produced by the inner deconstruction assignment.
        let rendered = Render(`
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
`)
        Assert.Contains("let (aValue, bValue) = (1, 2)", rendered, StringComparison.Ordinal)
        Assert.Contains("a = aValue", rendered, StringComparison.Ordinal)
        Assert.Contains("b = bValue", rendered, StringComparison.Ordinal)
        Assert.Contains("x = (aValue, bValue)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func DiscardTarget_InExpressionPosition_StillCapturesValueInRealTemp() {
        // Unlike the statement form (issue #1895), a discard here still
        // needs a real temp: its value feeds the deconstruction assignment's
        // own result.
        let rendered = Render(`
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
`)
        Assert.Contains("let (xValue, deconstructedValue) = (1, 2)", rendered, StringComparison.Ordinal)
        Assert.Contains("x = xValue", rendered, StringComparison.Ordinal)
        Assert.Contains("let r = (xValue, deconstructedValue)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("(xValue, _)", rendered, StringComparison.Ordinal)
        // Issue #2099: the discard still gets a real temp to feed the
        // expression's value, but `_` isn't a real assignable location — no
        // stray discard write-back should be emitted for it.
        Assert.DoesNotContain("_ = deconstructedValue", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NestedTarget_InExpressionPosition_ReadsBackNestedTupleValue() {
        // `((a, b), c) = ...` used as a value: the nested arm's value is
        // rebuilt as its own nested tuple literal (issue #1974 generalizes
        // the nested-target support added for the statement form).
        let rendered = Render(`
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
`)
        Assert.Contains("let (aTuple, cValue) = ((1, 2), 3)", rendered, StringComparison.Ordinal)
        Assert.Contains("let (aValue, bValue) = aTuple", rendered, StringComparison.Ordinal)
        Assert.Contains("a = aValue", rendered, StringComparison.Ordinal)
        Assert.Contains("b = bValue", rendered, StringComparison.Ordinal)
        Assert.Contains("c = cValue", rendered, StringComparison.Ordinal)
        Assert.Contains("let r = ((aValue, bValue), cValue)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NonIdentifierTarget_InExpressionPosition_NowLowersWithoutGap() {
        // Issue #2234 generalizes the #1895/#1974 lowering to element/member-
        // access targets reached via the value-position hoisting seam too:
        // `arr`/`i` are captured into temps before the RHS is spilled.
        let rendered = Render(`
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
`)
        AssertRoundTripParses(rendered)
        Assert.Contains("arr[i]", rendered)
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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
