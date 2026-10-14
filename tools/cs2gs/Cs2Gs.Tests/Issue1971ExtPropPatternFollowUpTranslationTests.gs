// <copyright file="Issue1971ExtPropPatternFollowUpTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1971: two Opus-review follow-ups from #1969/#1891's extended
/// property-subpattern (`{ Start.X: 0 }`) lowering.
///
/// 1. Null-safety divergence: C#'s extended property subpattern implicitly
/// null-checks every intermediate member of the dotted chain — a null
/// intermediate means the whole pattern falls through (no match, no throw).
/// The switch-arm lowering (nested `PropertyPattern`s) already gets this
/// for free from `MethodBodyEmitter.EmitPropertyPattern`'s own
/// `NullableTypeSymbol` guard (issue #1923) as long as the intermediate
/// field's G# type stays nullable (`Point?`). The is-form lowering had no
/// such guard — it flattened the whole path into one raw member-access chain
/// (`s.Start.X == 0`), so a null NULLABLE intermediate NREs instead of
/// falling through. These tests assert the is-form now emits an explicit
/// `!= nil` guard for a nullable-reference intermediate, and stays
/// guard-free for a non-nullable one (G#'s own non-null contract already
/// covers that case).
///
/// 2. Shared-prefix chains (`{ A.B: 0, A.C: 1 }`) previously lowered to
/// `{ A: { B: 0 }, A: { C: 1 } }` — a duplicate top-level field. These
/// tests assert subpatterns sharing a leftmost identifier now merge into ONE
/// nested field, to any shared-prefix depth.
open class Issue1971ExtPropPatternFollowUpTranslationTests {
    @Fact
    func IsPattern_NullableIntermediate_EmitsNullGuardBeforeMemberChain() {
        let rendered = Render(NullableStartSource + `
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
`)
        // Issue #4356: a nullable intermediate takes G#'s native property
        // pattern, which reads `Start` once and falls through on nil exactly
        // as C# does (`EmitPropertyPattern`'s NullableTypeSymbol guard). The
        // old guard-lowered `s.Start != nil && s.Start.X == 0` read it twice
        // and never bound, since G# does not narrow a mutable field chain.
        Assert.Contains("s is { Start: { X: 0 } }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("s.Start", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_NonNullableIntermediate_StaysGuardFree() {
        let rendered = Render(NonNullableStartSource + `
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
`)
        Assert.Contains("s.Start.X == 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("s.Start != nil", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IsPattern_NullableDeepChain_GuardsEveryNullableIntermediate() {
        let rendered = Render(`
#nullable enable
namespace Corpus.Issue1971
{
    public class C
    {
        public int Value;
    }

    public class B
    {
        public C? C;
    }

    public class A
    {
        public B? B;
    }

    public class Holder
    {
        public bool Describe(A a)
        {
            if (a is { B.C.Value: 0 })
            {
                return true;
            }

            return false;
        }
    }
}
`)
        Assert.Contains("a is { B: { C: { Value: 0 } } }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("a.B", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_SharedPrefixSubpatterns_MergeIntoOneNestedField() {
        let rendered = Render(`
namespace Corpus.Issue1971
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

    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0, Start.Y: 0 } => "origin",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ Start: { X: 0, Y: 0 } }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Start: { X: 0 }, Start:", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_DeepSharedPrefixSubpatterns_MergeAtDeepestCommonAncestor() {
        let rendered = Render(`
namespace Corpus.Issue1971
{
    public class C
    {
        public int Value1;
        public int Value2;
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
            { B.C.Value1: 0, B.C.Value2: 1 } => "zero",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ B: { C: { Value1: 0, Value2: 1 } } }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_SharedPrefixCombinedWithSimpleSubpattern_PreservesFieldOrder() {
        let rendered = Render(`
namespace Corpus.Issue1971
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

    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Length: 1, Start.X: 0, Start.Y: 0 } => "match",
            _ => "other",
        };
    }
}
`)
        // "Start" merges its two subpatterns into one nested field at its
        // FIRST occurrence — after "Length", which comes first in the source.
        Assert.Contains("{ Length: 1, Start: { X: 0, Y: 0 } }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_LeafThenNestedCollisionOnSameSegment_ReportsUnsupportedInsteadOfSilentlyDroppingSubpattern() {
        // Bug (N1, Opus review of #1971): `A.B: not null` (leaf check on `B`)
        // and `A.B.C: 1` (nested check under `B`) target the same path
        // segment `B`, ONE LEVEL UNDER the shared root `A`, in two
        // incompatible ways. The merge optimization must not silently keep
        // one and drop the other — it must report a loud gap. (`B: not null`
        // is used as the leaf check — rather than `B: null`, which would make
        // the arm statically unreachable per CS8510 since it contradicts the
        // nested `B.C` check — since a reference-typed `B` can be
        // pattern-compared against `not null` while ALSO exposing a member
        // for the nested check; an `int` leaf check couldn't do both, since
        // `int` has no further members to nest into.)
        let (unit, context) = RenderAllowingDiagnostics(`
namespace Corpus.Issue1971
{
    public class TypeB
    {
        public int C;
    }

    public class TypeA
    {
        public TypeB B;
    }

    public class RootHolder
    {
        public TypeA A;
    }

    public class Holder
    {
        public string Describe(RootHolder root) => root switch
        {
            { A.B: not null, A.B.C: 1 } => "match",
            _ => "other",
        };
    }
}
`)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "'B'",
                StringComparison.Ordinal
            ) &&
                d.Message!!.Contains("'A'", StringComparison.Ordinal)
        )
        let rendered = GSharpPrinter.Print(unit)
        // Neither subpattern's condition should be silently emitted as if the
        // merge had fully succeeded (that would hide the data loss).
        Assert.DoesNotContain("{ A: { B: { C: 1 } } }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("B: not nil", rendered, StringComparison.Ordinal)
    }

    @Fact
    func SwitchExpression_NestedThenLeafCollisionOnSameSegment_ReportsUnsupportedInsteadOfSilentlyDroppingSubpattern() {
        // Mirror case of the above: the nested-member check (`A.B.C: 1`) is
        // seen BEFORE the leaf check (`A.B: not null`) on the same segment
        // `B`. Must still report the gap loudly, not silently drop either
        // side.
        let (unit, context) = RenderAllowingDiagnostics(`
namespace Corpus.Issue1971
{
    public class TypeB
    {
        public int C;
    }

    public class TypeA
    {
        public TypeB B;
    }

    public class RootHolder
    {
        public TypeA A;
    }

    public class Holder
    {
        public string Describe(RootHolder root) => root switch
        {
            { A.B.C: 1, A.B: not null } => "match",
            _ => "other",
        };
    }
}
`)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "'B'",
                StringComparison.Ordinal
            ) &&
                d.Message!!.Contains("'A'", StringComparison.Ordinal)
        )
        let rendered = GSharpPrinter.Print(unit)
        Assert.DoesNotContain("{ A: { B: { C: 1 } } }", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("B: not nil", rendered, StringComparison.Ordinal)
    }

    @Fact
    func SwitchArm_NullableIntermediate_PreservesNestedFieldForEmitterNullGuard() {
        // Switch-arm counterpart to IsPattern_NullableIntermediate_EmitsNullGuardBeforeMemberChain:
        // the switch-arm lowering (nested PropertyPattern, not a flattened
        // member-access chain) should free-ride on gsc's existing #1923
        // null-guard in MethodBodyEmitter.EmitPropertyPattern, as long as the
        // intermediate field's G# type stays nullable (`Start` on `Point?`).
        let rendered = Render(NullableStartSource + `
    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0 } => "origin-x",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("{ Start: { X: 0 } }", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private const NullableStartSource string = `
#nullable enable
namespace Corpus.Issue1971
{
    public class Point
    {
        public int X;
        public int Y;
    }

    public class Segment
    {
        public Point? Start;
        public int Length;
    }
`

        private const NonNullableStartSource string = `
#nullable enable
namespace Corpus.Issue1971
{
    public class Point
    {
        public int X;
        public int Y;
    }

    public class Segment
    {
        public Point Start = new Point();
        public int Length;
    }
`

        private func RenderAllowingDiagnostics(source string)(Unit CompilationUnit, Context TranslationContext) {
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
            return (unit, context)
        }

        private func AssertRoundTripParses(rendered string, roundTripOnlyReason string? = nil) {
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(rendered)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(rendered, roundTripOnlyReason)
            }
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
