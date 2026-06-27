// <copyright file="Issue1232NumericErgonomicsBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1232: implicit numeric ergonomics aligning G# with C#.
///
/// (1) Shift-count widening — the RHS of <c>&lt;&lt;</c> / <c>&gt;&gt;</c> /
///     <c>&lt;&lt;=</c> / <c>&gt;&gt;=</c> may be any integer that implicitly
///     converts to <c>int32</c> (sbyte/byte/short/ushort/char); G# widens it to
///     int32 instead of reporting GS0129. The result type stays the left
///     operand's type. Counts that do NOT implicitly convert to int32
///     (uint32/int64/...) still error, matching C#.
///
/// (2) Value-producing <c>if</c> / conditional arms — an in-range constant
///     integer literal arm adapts to the other arm's integer type, so
///     <c>if cond { someUint32 } else { 0 }</c> binds without an explicit cast.
///
/// (3) <c>==</c> (and comparison) numeric-literal ergonomics — idiomatic
///     comparisons such as <c>someUint8 == 11</c> bind via implicit widening +
///     in-range literal adaptation (regression coverage; nullable operands are a
///     deliberate gap tracked by #1236).
/// </summary>
public class Issue1232NumericErgonomicsBinderTests
{
    // ── (1) Shift-count widening ───────────────────────────────────────

    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    public void ShiftLeft_NarrowOrderCount_WidensToInt32(string countType)
    {
        var source = Wrap("func F(value uint32, count " + countType + ") uint32 { return value << count }");
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    public void ShiftRight_NarrowOrderCount_WidensToInt32(string countType)
    {
        var source = Wrap("func F(value uint32, count " + countType + ") uint32 { return value >> count }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void Shift_CharCount_WidensToInt32()
    {
        var source = Wrap("func F(value uint32, count char) uint32 { return value << count }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void Shift_SubI4LeftOperand_NarrowCount_Compiles()
    {
        // The left operand's type is preserved; the count widens to int32.
        var source = Wrap("func F(value uint8, count uint8) uint8 { return value << count }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void CompoundShiftLeft_NarrowCount_WidensToInt32()
    {
        var source = Wrap(@"func F(value uint32, count uint8) uint32 {
        var v = value
        v <<= count
        return v
    }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void CompoundShiftRight_NarrowCount_WidensToInt32()
    {
        var source = Wrap(@"func F(value uint32, count uint16) uint32 {
        var v = value
        v >>= count
        return v
    }");
        Assert.Empty(Errors(source));
    }

    // Counts that do NOT implicitly convert to int32 still error (C# also
    // rejects a uint/long/... shift count).
    [Theory]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    public void Shift_NonWideningCount_StillErrorsGS0129(string countType)
    {
        var source = Wrap("func F(value uint32, count " + countType + ") uint32 { return value << count }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    // ── (2) Value-producing if / conditional arms ──────────────────────

    [Fact]
    public void ValueIf_Uint32ThenZeroElse_AdaptsLiteralArm()
    {
        var source = Wrap("func F(cond bool, u uint32) uint32 { return if cond { u } else { 0 } }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ValueIf_ZeroThenUint32Else_AdaptsLiteralArm()
    {
        var source = Wrap("func F(cond bool, u uint32) uint32 { return if cond { 0 } else { u } }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void Ternary_Uint32AndZero_AdaptsLiteralArm()
    {
        var source = Wrap("func F(cond bool, u uint32) uint32 { return cond ? u : 0 }");
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("uint64")]
    public void ValueIf_LiteralArm_AdaptsAcrossIntegerTypes(string type)
    {
        var source = Wrap("func F(cond bool, v " + type + ") " + type + " { return if cond { v } else { 0 } }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ValueIf_TypedArmsThatWiden_StillUnify()
    {
        // Directional widening across typed arms (uint16 widens to uint32).
        var source = Wrap("func F(cond bool, a uint16, b uint32) uint32 { return if cond { a } else { b } }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ValueIf_OutOfRangeLiteralArm_StillErrors()
    {
        // 999 is not representable in uint8, so it is NOT silently adapted. The
        // arms unify to int32 (uint8 widens to int32, like C#'s common type),
        // and returning that int32 where uint8 is expected still errors — the
        // out-of-range literal never wraps.
        var source = Wrap("func F(cond bool, v uint8) uint8 { return if cond { v } else { 999 } }");
        Assert.NotEmpty(Errors(source));
    }

    // ── (3) == / comparison numeric-literal ergonomics ─────────────────

    [Theory]
    [InlineData("c == 11")]
    [InlineData("c != 11")]
    [InlineData("c < 11")]
    [InlineData("c >= 11")]
    public void Comparison_Uint8WithIntLiteral_Compiles(string expr)
    {
        var source = Wrap("func F(c uint8) bool { return " + expr + " }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void Equality_Uint32WithZeroLiteral_Compiles()
    {
        var source = Wrap("func F(u uint32) bool { return u == 0 }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void Equality_MixedWidthNonNullable_WidensImplicitly()
    {
        var source = Wrap("func F(a uint16, b uint32) bool { return a == b }");
        Assert.Empty(Errors(source));
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
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
