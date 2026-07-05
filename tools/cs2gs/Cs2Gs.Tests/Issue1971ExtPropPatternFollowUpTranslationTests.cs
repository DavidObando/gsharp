// <copyright file="Issue1971ExtPropPatternFollowUpTranslationTests.cs" company="GSharp">
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
/// Issue #1971: two Opus-review follow-ups from #1969/#1891's extended
/// property-subpattern (<c>{ Start.X: 0 }</c>) lowering.
///
/// 1. Null-safety divergence: C#'s extended property subpattern implicitly
/// null-checks every intermediate member of the dotted chain — a null
/// intermediate means the whole pattern falls through (no match, no throw).
/// The switch-arm lowering (nested <c>PropertyPattern</c>s) already gets this
/// for free from <c>MethodBodyEmitter.EmitPropertyPattern</c>'s own
/// <c>NullableTypeSymbol</c> guard (issue #1923) as long as the intermediate
/// field's G# type stays nullable (<c>Point?</c>). The is-form lowering had no
/// such guard — it flattened the whole path into one raw member-access chain
/// (<c>s.Start.X == 0</c>), so a null NULLABLE intermediate NREs instead of
/// falling through. These tests assert the is-form now emits an explicit
/// <c>!= nil</c> guard for a nullable-reference intermediate, and stays
/// guard-free for a non-nullable one (G#'s own non-null contract already
/// covers that case).
///
/// 2. Shared-prefix chains (<c>{ A.B: 0, A.C: 1 }</c>) previously lowered to
/// <c>{ A: { B: 0 }, A: { C: 1 } }</c> — a duplicate top-level field. These
/// tests assert subpatterns sharing a leftmost identifier now merge into ONE
/// nested field, to any shared-prefix depth.
/// </summary>
public class Issue1971ExtPropPatternFollowUpTranslationTests
{
    private const string NullableStartSource = @"
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
";

    private const string NonNullableStartSource = @"
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
";

    [Fact]
    public void IsPattern_NullableIntermediate_EmitsNullGuardBeforeMemberChain()
    {
        string rendered = Render(NullableStartSource + @"
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

        Assert.Contains("s.Start != nil && s.Start.X == 0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_NonNullableIntermediate_StaysGuardFree()
    {
        string rendered = Render(NonNullableStartSource + @"
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
        Assert.DoesNotContain("s.Start != nil", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_NullableDeepChain_GuardsEveryNullableIntermediate()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("a.B != nil && a.B.C != nil && a.B.C.Value == 0", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_SharedPrefixSubpatterns_MergeIntoOneNestedField()
    {
        string rendered = Render(@"
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
            { Start.X: 0, Start.Y: 0 } => ""origin"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ Start: { X: 0, Y: 0 } }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Start: { X: 0 }, Start:", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_DeepSharedPrefixSubpatterns_MergeAtDeepestCommonAncestor()
    {
        string rendered = Render(@"
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
            { B.C.Value1: 0, B.C.Value2: 1 } => ""zero"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ B: { C: { Value1: 0, Value2: 1 } } }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_SharedPrefixCombinedWithSimpleSubpattern_PreservesFieldOrder()
    {
        string rendered = Render(@"
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
            { Length: 1, Start.X: 0, Start.Y: 0 } => ""match"",
            _ => ""other"",
        };
    }
}
");

        // "Start" merges its two subpatterns into one nested field at its
        // FIRST occurrence — after "Length", which comes first in the source.
        Assert.Contains("{ Length: 1, Start: { X: 0, Y: 0 } }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_LeafThenNestedCollisionOnSameSegment_ReportsUnsupportedInsteadOfSilentlyDroppingSubpattern()
    {
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
        (Cs2Gs.CodeModel.Ast.CompilationUnit unit, TranslationContext context) = RenderAllowingDiagnostics(@"
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
            { A.B: not null, A.B.C: 1 } => ""match"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("'B'", StringComparison.Ordinal)
                && d.Message.Contains("'A'", StringComparison.Ordinal));

        string rendered = GSharpPrinter.Print(unit);

        // Neither subpattern's condition should be silently emitted as if the
        // merge had fully succeeded (that would hide the data loss).
        Assert.DoesNotContain("{ A: { B: { C: 1 } } }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("B: not nil", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void SwitchExpression_NestedThenLeafCollisionOnSameSegment_ReportsUnsupportedInsteadOfSilentlyDroppingSubpattern()
    {
        // Mirror case of the above: the nested-member check (`A.B.C: 1`) is
        // seen BEFORE the leaf check (`A.B: not null`) on the same segment
        // `B`. Must still report the gap loudly, not silently drop either
        // side.
        (Cs2Gs.CodeModel.Ast.CompilationUnit unit, TranslationContext context) = RenderAllowingDiagnostics(@"
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
            { A.B.C: 1, A.B: not null } => ""match"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("'B'", StringComparison.Ordinal)
                && d.Message.Contains("'A'", StringComparison.Ordinal));

        string rendered = GSharpPrinter.Print(unit);

        Assert.DoesNotContain("{ A: { B: { C: 1 } } }", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("B: not nil", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void SwitchArm_NullableIntermediate_PreservesNestedFieldForEmitterNullGuard()
    {
        // Switch-arm counterpart to IsPattern_NullableIntermediate_EmitsNullGuardBeforeMemberChain:
        // the switch-arm lowering (nested PropertyPattern, not a flattened
        // member-access chain) should free-ride on gsc's existing #1923
        // null-guard in MethodBodyEmitter.EmitPropertyPattern, as long as the
        // intermediate field's G# type stays nullable (`Start` on `Point?`).
        string rendered = Render(NullableStartSource + @"
    public class Holder
    {
        public string Describe(Segment s) => s switch
        {
            { Start.X: 0 } => ""origin-x"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ Start: { X: 0 } }", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static (Cs2Gs.CodeModel.Ast.CompilationUnit Unit, TranslationContext Context) RenderAllowingDiagnostics(string source)
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
        return (unit, context);
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
