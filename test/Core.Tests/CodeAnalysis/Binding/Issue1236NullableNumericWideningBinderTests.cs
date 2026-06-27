// <copyright file="Issue1236NullableNumericWideningBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1236: a lifted (nullable) binary operator must honour the same
/// implicit lossless integer-widening lattice and constant-integer-literal
/// adaptation as its non-nullable counterpart, operating on the underlying
/// numeric types and re-wrapping the result nullability. Previously a lifted
/// operator only bound when both operands shared the same underlying numeric
/// type, so e.g. <c>uint8? == 11</c> and <c>uint8? == int32</c> failed with
/// GS0129 even though their non-nullable forms compile. Guardrails (out-of-range
/// literals, non-widening mixed pairs) still error in BOTH nullable and
/// non-nullable forms.
/// </summary>
public class Issue1236NullableNumericWideningBinderTests
{
    // ── Constant integer-literal adaptation against a nullable operand ──

    [Theory]
    [InlineData("b uint8?", "b == 11")]
    [InlineData("b int64?", "b == 11")]
    [InlineData("b uint8?", "b != 11")]
    [InlineData("b int64?", "b < 11")]
    public void LiftedLiteralAdaptation_Binds(string parms, string expr)
    {
        var source = Wrap($"func F({parms}) bool {{ return {expr} }}");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void LiftedLiteralArithmeticAdaptation_Binds()
    {
        // literal 11 (int32) adapts to int64; binds at int64 lifted -> int64?.
        var source = Wrap("func F(b int64?) int64? { return b + 11 }");
        Assert.Empty(Errors(source));
    }

    // ── Directional widening between nullable / mixed operands ─────────

    [Theory]
    [InlineData("a uint8?, b int32", "a == b")]
    [InlineData("a uint8?, b int32?", "a == b")]
    [InlineData("a uint8, b int32?", "a == b")]
    [InlineData("a uint8?, b int32?", "a < b")]
    [InlineData("a uint32?, b int64?", "a + b == 0")]
    public void LiftedDirectionalWidening_Binds(string parms, string expr)
    {
        var source = Wrap($"func F({parms}) bool {{ return {expr} }}");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void LiftedArithmeticWidening_ProducesNullableResult()
    {
        var source = Wrap("func F(a int64?, b int32?) int64? { return a + b }");
        Assert.Empty(Errors(source));
    }

    // ── Existing behaviour preserved ───────────────────────────────────

    [Fact]
    public void LiftedSameUnderlying_StillBinds()
    {
        var source = Wrap("func F(a int32?) bool { return a == 11 }");
        Assert.Empty(Errors(source));
    }

    // ── Guardrails: out-of-range / non-widening still error ────────────

    [Fact]
    public void LiftedLiteralOutOfRange_StillErrors()
    {
        // 300 is out of range for uint8; an explicit cast is still required.
        var source = Wrap("func F(b uint8?) bool { return b == 300 }");
        Assert.NotEmpty(Errors(source));
    }

    [Fact]
    public void LiftedNonWideningPair_UInt32VsInt32_StillErrorsGS0129()
    {
        // Neither uint32 nor int32 implicitly converts to the other, so the
        // lifted operator stays unbound — consistent with the non-nullable form.
        var source = Wrap("func F(a uint32?, b int32?) bool { return a == b }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    [Fact]
    public void NonNullableNonWideningPair_UInt32VsInt32_StillErrorsGS0129()
    {
        var source = Wrap("func F(a uint32, b int32) bool { return a == b }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    private static string Wrap(string member)
    {
        return @"
package p
class C {
    " + member + @"
}
";
    }

    private static IReadOnlyList<Diagnostic> Errors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
