// <copyright file="Issue1943TypedPositionalSubpatternTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1943 (follow-up from PR #1939 / issue #1887): a TYPED recursive
/// pattern (`Point(0, 0) => …`) lowers to a G# `TypePattern`
/// node, which — unlike a bare/untyped positional arm's `PropertyPattern`
/// — has no room for an extra equality/relational field. A constant or
/// relational (or nested) positional subpattern in that position previously
/// only accepted `var`; anything else emitted a loud
/// `CS2GS-GAP: positional subpattern has no canonical G# form yet`
/// diagnostic. It now generalizes the untyped-arm lowering by synthesizing the
/// same member-access boolean test and AND-ing it into the arm's `when`
/// guard (`case Point point when point.X == 0 && point.Y == 0:`).
///
/// Also covers the related null-guard gap: a nullable value-type tuple
/// subject (`(int, int)? is (0, 0)`) narrows to the same non-nullable
/// `MatchedType` a non-nullable tuple does, which previously skipped the
/// null check unconditionally for any value-type receiver — wrongly, since a
/// nullable subject can still be null at runtime and the emitted G#
/// (`p.Item1 == 0`) would fault. It now guards nullable value-type
/// subjects with the same `!= nil` test a reference-type receiver gets.
open class Issue1943TypedPositionalSubpatternTests {
    @Fact
    func SwitchExpression_TypedPositionalConstantSubpattern_LowersToWhenGuard() {
        // `Point(0, 0) =>` must keep BOTH constant positions as a `when`
        // guard on the synthesized `point` designator, not silently accept
        // only `var` positions.
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public record Point(int X, int Y);

    public class Holder
    {
        public string Describe(object o)
        {
            return o switch
            {
                Point(0, 0) => "origin",
                _ => "other",
            };
        }
    }
}
`)
        Assert.Contains("case point is Point when point.X == 0 && point.Y == 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("CS2GS-GAP", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_TypedPositionalRelationalSubpattern_LowersToWhenGuard() {
        // `Point(> 0, _) =>`: a relational sub-pattern alongside a discard
        // position — the discard contributes no test, the relational
        // position becomes the sole guard clause.
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public record Point(int X, int Y);

    public class Holder
    {
        public string Describe(object o)
        {
            return o switch
            {
                Point( > 0, _) => "positive-x",
                _ => "other",
            };
        }
    }
}
`)
        Assert.Contains("case point is Point when point.X > 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("CS2GS-GAP", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_TypedPositionalSubpattern_CombinesWithExplicitWhenClause() {
        // The synthesized guard must AND with (not replace) an explicit
        // user `when` clause on the same arm.
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public record Point(int X, int Y);

    public class Holder
    {
        public string Describe(object o, bool flag)
        {
            return o switch
            {
                Point(0, 0) when flag => "origin-flagged",
                _ => "other",
            };
        }
    }
}
`)
        Assert.Contains("when point.X == 0 && point.Y == 0 && flag", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_NestedTypedPositionalSubpattern_LowersToWhenGuard() {
        // A nested typed positional pattern (`Line(Point(0, 0), _)`) inside a
        // typed positional slot: the nested test recurses through the same
        // boolean-test machinery the untyped arm form already uses.
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public record Point(int X, int Y);
    public record Line(Point Start, Point End);

    public class Holder
    {
        public string Describe(object o)
        {
            return o switch
            {
                Line(Point(0, 0), _) => "starts-at-origin",
                _ => "other",
            };
        }
    }
}
`)
        Assert.Contains("case line is Line when", rendered, StringComparison.Ordinal)
        Assert.Contains("line.Start.X == 0 && line.Start.Y == 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("CS2GS-GAP", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchStatement_TypedPositionalConstantSubpattern_LowersToWhenGuard() {
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public record Point(int X, int Y);

    public class Holder
    {
        public bool IsOrigin(object o)
        {
            switch (o)
            {
                case Point(0, 0):
                    return true;
                default:
                    return false;
            }
        }
    }
}
`)
        Assert.Contains("case point is Point when point.X == 0 && point.Y == 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("CS2GS-GAP", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_NullableValueTypeTuplePositionalSubject_GuardsAgainstNull() {
        // `(int, int)? is (0, 0)`: the pattern narrows to the same
        // non-nullable `(int, int)` a non-nullable tuple receiver would, but
        // the SUBJECT can still be null at runtime — the emitted G# must keep
        // the `!= nil` guard before testing `Item1`/`Item2`, unlike the
        // non-nullable-tuple case (issue #1887), which correctly omits it.
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public class Holder
    {
        public bool IsOrigin((int, int)? p)
        {
            return p is (0, 0);
        }
    }
}
`)
        Assert.Contains("p != nil && p!!.Item1 == 0 && p!!.Item2 == 0", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_NonNullableValueTypeTuplePositionalSubject_OmitsNullGuard() {
        // Regression guard (issue #1887): a NON-nullable tuple subject must
        // keep skipping the null check — G# rejects `!= nil` against a
        // value type that can never be null.
        let rendered = Render(`
namespace Corpus.Issue1943
{
    public class Holder
    {
        public bool IsOrigin((int, int) p)
        {
            return p is (0, 0);
        }
    }
}
`)
        Assert.Contains("p.Item1 == 0 && p.Item2 == 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("p != nil", rendered, StringComparison.Ordinal)
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
            return GSharpPrinter.Print(unit)
        }
    }
}
