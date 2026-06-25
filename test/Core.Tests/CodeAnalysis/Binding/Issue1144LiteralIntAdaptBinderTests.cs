// <copyright file="Issue1144LiteralIntAdaptBinderTests.cs" company="GSharp">
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
/// Issue #1144: a constant integer literal operand of a binary operator
/// adapts to the OTHER operand's integer type when its value is
/// representable there (C#-style constant-expression conversion). This is
/// local to binary-expression binding: conversions between two TYPED
/// integer operands still require an explicit cast, and an out-of-range
/// literal still errors (never silently wraps).
///
/// The result TYPE of each positive case is asserted indirectly but
/// precisely via the enclosing function's declared return type: if the
/// binary expression did not bind to the expected integer/bool type the
/// implicit `return` conversion would surface a diagnostic.
/// </summary>
public class Issue1144LiteralIntAdaptBinderTests
{
    // ── Arithmetic: uint32 operand + int literal → uint32 ──────────────

    [Theory]
    [InlineData("a + 1")]
    [InlineData("a - 1")]
    [InlineData("a * 2")]
    [InlineData("a / 2")]
    [InlineData("a % 2")]
    public void Arithmetic_UInt32OperandWithIntLiteral_BindsToUInt32(string expr)
    {
        var source = Wrap("func F(a uint32) uint32 { return " + expr + " }");
        Assert.Empty(Errors(source));
    }

    // ── Bitwise: uint8 operand | int literal → uint8 ───────────────────

    [Theory]
    [InlineData("b | 4")]
    [InlineData("b & 4")]
    [InlineData("b ^ 4")]
    public void Bitwise_UInt8OperandWithIntLiteral_BindsToUInt8(string expr)
    {
        var source = Wrap("func F(b uint8) uint8 { return " + expr + " }");
        Assert.Empty(Errors(source));
    }

    // ── Comparison: uint8 operand vs int literal → bool ────────────────

    [Theory]
    [InlineData("c == 0")]
    [InlineData("c != 0")]
    [InlineData("c < 10")]
    [InlineData("c >= 1")]
    public void Comparison_UInt8OperandWithIntLiteral_BindsToBool(string expr)
    {
        var source = Wrap("func F(c uint8) bool { return " + expr + " }");
        Assert.Empty(Errors(source));
    }

    // ── Literal on the LEFT adapts too ─────────────────────────────────

    [Fact]
    public void LiteralOnLeft_Arithmetic_BindsToUInt32()
    {
        var source = Wrap("func F(a uint32) uint32 { return 1 + a }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void LiteralOnLeft_Comparison_BindsToBool()
    {
        var source = Wrap("func F(c uint8) bool { return 0 == c }");
        Assert.Empty(Errors(source));
    }

    // ── Each of the ten integer target types ───────────────────────────

    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void AllIntegerTargetTypes_LiteralAdapts(string type)
    {
        var source = Wrap("func F(v " + type + ") " + type + " { return v + 1 }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void Int64Operand_WithIntLiteral_BindsToInt64()
    {
        var source = Wrap("func F(l int64) int64 { return l + 1 }");
        Assert.Empty(Errors(source));
    }

    // ── Negative cases: must STILL error ───────────────────────────────

    [Fact]
    public void OutOfRangeLiteral_UInt8_StillErrorsGS0129()
    {
        var source = Wrap("func F(c uint8) bool { return c == 999 }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    [Fact]
    public void NegativeLiteral_NotRepresentableInUInt32_StillErrorsGS0129()
    {
        var source = Wrap("func F(a uint32) uint32 { return a + -1 }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    [Fact]
    public void TwoTypedIntegerOperands_StillErrorsGS0129()
    {
        // No literal involved: uint8 + int32 between two typed locals still
        // requires an explicit cast (general conversion path untouched).
        var source = Wrap(@"func F(x uint8, y int32) int32 {
        return int32(x + y)
    }");
        Assert.Contains(Errors(source), d => d.Id == "GS0129");
    }

    [Fact]
    public void TypedVariableNarrowing_StillErrorsGS0156()
    {
        // Proves the general numeric-conversion path is untouched: assigning
        // a (typed int32) literal-initialized value to a uint8 still needs a
        // cast. `let a uint8 = 4` narrows int32 -> uint8 and reports GS0156.
        var source = Wrap("func F() { let a uint8 = 4 }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    // ── Regression: pre-existing behaviour preserved ───────────────────

    [Fact]
    public void TwoIntLiterals_StillBindToInt32()
    {
        var source = Wrap("func F() int32 { return 1 + 2 }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ExplicitCastWorkaround_StillCompiles()
    {
        var source = Wrap("func F(a uint32) uint32 { return a + uint32(1) }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ShiftWithIntRhs_StillCompiles()
    {
        var source = Wrap("func F(a uint32) uint32 { return a << 8 }");
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
