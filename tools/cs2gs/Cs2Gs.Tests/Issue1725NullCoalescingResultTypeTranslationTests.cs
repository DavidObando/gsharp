// <copyright file="Issue1725NullCoalescingResultTypeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for issue #1725: <c>TranslateNullCoalescing</c>
/// unconditionally coerced the right operand of <c>a ?? b</c> down to the
/// left operand's underlying numeric type whenever the two numeric kinds
/// differed. That only matches C# when the right operand implicitly converts
/// to the left's underlying type. When the right side is wider, C# types
/// <c>a ?? b</c> as the right operand's (wider) type and converts the LEFT's
/// value instead — the old code silently truncated the right operand down to
/// the left's narrower type. The fix keys the coercion off the whole
/// expression's C#-computed result type (<c>GetTypeInfo(binary).Type</c>) and
/// only touches the right operand when it differs from that result; the left
/// operand's non-null value is widened automatically by gsc's own <c>??</c>
/// binder (issue #1239) so it never needs a cs2gs-side rewrite.
/// </summary>
public class Issue1725NullCoalescingResultTypeTranslationTests
{
    /// <summary>
    /// Right operand wider than left (<c>long</c> vs. <c>int32?</c>): C# types
    /// the whole expression as <c>long</c>, so the right operand must NOT be
    /// coerced down to <c>int32</c> (which would truncate it at runtime).
    /// </summary>
    [Fact]
    public void RightWiderThanLeft_DoesNotTruncateRightOperand()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public long N(int? nInt, long longDefault) => nInt ?? longDefault;
    }
}");

        Assert.Contains("nInt ?? longDefault", printed);
        Assert.DoesNotContain("int32(longDefault)", printed);
    }

    /// <summary>
    /// Right operand is a wider floating-point constant (<c>2.5</c>): the
    /// whole expression is typed <c>double</c> by C#, so the literal must
    /// keep its fractional value and must not be narrowed to <c>int32</c>.
    /// </summary>
    [Fact]
    public void DoubleResultWithIntegerLeft_KeepsFractionalConstant()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double N(int? nInt) => nInt ?? 2.5;
    }
}");

        Assert.Contains("nInt ?? 2.5", printed);
        Assert.DoesNotContain("int32(2.5)", printed);
    }

    /// <summary>
    /// Right operand is a wider, non-constant <c>double</c> variable: same
    /// widening rule applies to a non-literal right operand.
    /// </summary>
    [Fact]
    public void DoubleResultWithIntegerLeft_NonConstantRight_NotCoerced()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public double N(int? nInt, double otherDouble) => nInt ?? otherDouble;
    }
}");

        Assert.Contains("nInt ?? otherDouble", printed);
        Assert.DoesNotContain("int32(otherDouble)", printed);
    }

    /// <summary>
    /// Left operand wider than right (<c>long?</c> vs. a narrower constant):
    /// C# types the whole expression as <c>long</c>, so the narrower right
    /// operand is coerced UP to the result type (pre-existing, still-correct
    /// direction for this coercion).
    /// </summary>
    [Fact]
    public void LeftWiderThanRight_CoercesRightUpToResultType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public long N(long? nLong) => nLong ?? 7;
    }
}");

        Assert.Contains("nLong ?? int64(7)", printed);
    }

    /// <summary>
    /// Equal numeric kinds (<c>uint?</c> vs. <c>uint</c>): no coercion is
    /// inserted at all — this is the pre-existing early-out and must stay
    /// untouched by the result-type rework.
    /// </summary>
    [Fact]
    public void EqualNumericKinds_NoSpuriousCoercion()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint N(uint? x, uint fallback) => x ?? fallback;
    }
}");

        Assert.Contains("x ?? fallback", printed);
        Assert.DoesNotContain("uint32(fallback)", printed);
    }

    /// <summary>
    /// Regression guard for the original #914 scenario (right is a constant
    /// whose natural type differs from the result because of C#'s
    /// constant-literal conversion rule, not a general widening): the
    /// literal still needs an explicit coercion because gsc's own <c>??</c>
    /// binder does not special-case constant-literal conversions the way C#
    /// does.
    /// </summary>
    [Fact]
    public void ConstantNarrowerThanUnsignedResult_StillCoerced()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public uint N(uint? x) => x ?? 0;
    }
}");

        Assert.Contains("?? uint32(0)", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
