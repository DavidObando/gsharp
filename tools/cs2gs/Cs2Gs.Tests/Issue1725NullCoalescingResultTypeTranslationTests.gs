// <copyright file="Issue1725NullCoalescingResultTypeTranslationTests.cs" company="GSharp">
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

/// Translation tests for issue #1725: `TranslateNullCoalescing`
/// unconditionally coerced the right operand of `a ?? b` down to the
/// left operand's underlying numeric type whenever the two numeric kinds
/// differed. That only matches C# when the right operand implicitly converts
/// to the left's underlying type. When the right side is wider, C# types
/// `a ?? b` as the right operand's (wider) type and converts the LEFT's
/// value instead — the old code silently truncated the right operand down to
/// the left's narrower type. The fix keys the coercion off the whole
/// expression's C#-computed result type (`GetTypeInfo(binary).Type`) and
/// only touches the right operand when it differs from that result; the left
/// operand's non-null value is widened automatically by gsc's own `??`
/// binder (issue #1239) so it never needs a cs2gs-side rewrite.
open class Issue1725NullCoalescingResultTypeTranslationTests {
    /// Right operand wider than left (`long` vs. `int32?`): C# types
    /// the whole expression as `long`, so the right operand must NOT be
    /// coerced down to `int32` (which would truncate it at runtime).
    @Fact
    func RightWiderThanLeft_DoesNotTruncateRightOperand() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public long N(int? nInt, long longDefault) => nInt ?? longDefault;
    }
}`)
        Assert.Contains("nInt ?? longDefault", printed)
        Assert.DoesNotContain("int32(longDefault)", printed)
    }

    /// Right operand is a wider floating-point constant (`2.5`): the
    /// whole expression is typed `double` by C#, so the literal must
    /// keep its fractional value and must not be narrowed to `int32`.
    @Fact
    func DoubleResultWithIntegerLeft_KeepsFractionalConstant() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double N(int? nInt) => nInt ?? 2.5;
    }
}`)
        Assert.Contains("nInt ?? 2.5", printed)
        Assert.DoesNotContain("int32(2.5)", printed)
    }

    /// Right operand is a wider, non-constant `double` variable: same
    /// widening rule applies to a non-literal right operand.
    @Fact
    func DoubleResultWithIntegerLeft_NonConstantRight_NotCoerced() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double N(int? nInt, double otherDouble) => nInt ?? otherDouble;
    }
}`)
        Assert.Contains("nInt ?? otherDouble", printed)
        Assert.DoesNotContain("int32(otherDouble)", printed)
    }

    /// Left operand wider than right (`long?` vs. a narrower constant):
    /// C# types the whole expression as `long`, so the narrower right
    /// operand is coerced UP to the result type (pre-existing, still-correct
    /// direction for this coercion).
    @Fact
    func LeftWiderThanRight_CoercesRightUpToResultType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public long N(long? nLong) => nLong ?? 7;
    }
}`)
        Assert.Contains("nLong ?? int64(7)", printed)
    }

    /// Equal numeric kinds (`uint?` vs. `uint`): no coercion is
    /// inserted at all — this is the pre-existing early-out and must stay
    /// untouched by the result-type rework.
    @Fact
    func EqualNumericKinds_NoSpuriousCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint N(uint? x, uint fallback) => x ?? fallback;
    }
}`)
        Assert.Contains("x ?? fallback", printed)
        Assert.DoesNotContain("uint32(fallback)", printed)
    }

    /// Regression guard for the original #914 scenario (right is a constant
    /// whose natural type differs from the result because of C#'s
    /// constant-literal conversion rule, not a general widening): the
    /// literal still needs an explicit coercion because gsc's own `??`
    /// binder does not special-case constant-literal conversions the way C#
    /// does.
    @Fact
    func ConstantNarrowerThanUnsignedResult_StillCoerced() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public uint N(uint? x) => x ?? 0;
    }
}`)
        Assert.Contains("?? uint32(0)", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
