// <copyright file="Issue1183NumericLiteralNarrowingBinderTests.cs" company="GSharp">
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
/// Issue #1183: C#-compatible numeric literal narrowing/widening.
///
/// * Implicit constant-expression conversions (C# §10.2.11): a constant
///   integer expression implicitly narrows to a smaller integer type when its
///   value is within the target's range — no cast required.
/// * An out-of-range constant narrowing stays an error.
/// * Non-constant narrowing still requires an explicit cast (GS0156).
/// * Non-constant widening is implicit (no cast).
/// * Explicit narrowing via the `T(x)` conversion-call form compiles.
/// </summary>
public class Issue1183NumericLiteralNarrowingBinderTests
{
    // ── In-range constant narrowing compiles without a cast ────────────

    [Theory]
    [InlineData("int8", "100")]
    [InlineData("int8", "-100")]
    [InlineData("uint8", "42")]
    [InlineData("uint8", "255")]
    [InlineData("uint8", "0")]
    [InlineData("int16", "100")]
    [InlineData("int16", "-30000")]
    [InlineData("uint16", "5")]
    [InlineData("uint16", "65535")]
    [InlineData("int32", "2147483647")]
    [InlineData("uint32", "5")]
    public void InRangeConstantNarrowing_Compiles(string type, string value)
    {
        var source = Wrap("func F() { var x " + type + " = " + value + " }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void InRangeConstantNarrowing_AssignmentStatement_Compiles()
    {
        var source = Wrap("func F() { var x uint8 = 0 x = 200 }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void NegativeInRangeConstant_NarrowsToSigned()
    {
        var source = Wrap("func F() { var x int8 = -5 }");
        Assert.Empty(Errors(source));
    }

    // ── Out-of-range constant narrowing must STILL error ───────────────

    [Theory]
    [InlineData("uint8", "300")]
    [InlineData("uint8", "-1")]
    [InlineData("int8", "200")]
    [InlineData("int8", "-200")]
    [InlineData("int16", "40000")]
    [InlineData("uint16", "70000")]
    [InlineData("uint32", "-1")]
    public void OutOfRangeConstantNarrowing_StillErrors(string type, string value)
    {
        var source = Wrap("func F() { var x " + type + " = " + value + " }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    // ── Non-constant narrowing requires an explicit cast ───────────────

    [Fact]
    public void NonConstantNarrowing_RequiresCast_Errors()
    {
        // `n` is a (non-constant) int32 parameter — narrowing to uint8 needs a
        // cast and must NOT be allowed implicitly.
        var source = Wrap("func F(n int32) { var x uint8 = n }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    [Fact]
    public void NonConstantNarrowing_Int64ToInt32_Errors()
    {
        var source = Wrap("func F(n int64) { var x int32 = n }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    [Fact]
    public void NonConstantNarrowing_Float64ToInt32_Errors()
    {
        var source = Wrap("func F(n float64) { var x int32 = n }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    // ── Non-constant widening is implicit ──────────────────────────────

    [Theory]
    [InlineData("int32", "int64")]
    [InlineData("int32", "float64")]
    [InlineData("int16", "int32")]
    [InlineData("uint8", "int32")]
    [InlineData("uint32", "int64")]
    [InlineData("float32", "float64")]
    public void NonConstantWidening_IsImplicit(string from, string to)
    {
        var source = Wrap("func F(n " + from + ") { var x " + to + " = n }");
        Assert.Empty(Errors(source));
    }

    // ── Explicit narrowing via the conversion-call form compiles ───────

    [Fact]
    public void ExplicitNarrowing_NonConstant_Compiles()
    {
        var source = Wrap("func F(n int64) int32 { return int32(n) }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ExplicitNarrowing_Float64ToInt32_Compiles()
    {
        var source = Wrap("func F(n float64) int32 { return int32(n) }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void ExplicitNarrowing_OutOfRangeConstant_Compiles()
    {
        // A C#-style explicit cast of an out-of-range constant truncates
        // (unchecked) and is permitted, just like `(byte)300` in C#.
        var source = Wrap("func F() uint8 { return uint8(300) }");
        Assert.Empty(Errors(source));
    }

    // ── Bare integer literals exceeding int32 infer a wider type ───────
    // C# §6.4.5.3: an un-suffixed decimal literal is typed as the first of
    // int32, uint32, int64, uint64 that can represent it. Combined with the
    // constant-narrowing rule above, a target-typed assignment then compiles
    // without a suffix.

    [Theory]
    [InlineData("uint32", "4294967295")]
    [InlineData("int64", "5000000000")]
    [InlineData("int64", "4294967296")]
    [InlineData("uint64", "18446744073709551615")]
    [InlineData("uint64", "5000000000")]
    public void OverInt32Literal_InTargetRange_Compiles(string type, string value)
    {
        var source = Wrap("func F() { var x " + type + " = " + value + " }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void OverInt32Literal_InfersUInt32_WhenItFits()
    {
        // 4294967295 fits uint32 but not int32; the inferred literal type is
        // uint32, so no widening is even required for a uint32 target.
        var source = Wrap("func F() uint32 { return 4294967295 }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void OverInt32Literal_InfersInt64_WhenItFits()
    {
        // 5000000000 exceeds uint32, so the inferred type is int64.
        var source = Wrap("func F() int64 { return 5000000000 }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void OverInt64Literal_InfersUInt64_WhenItFits()
    {
        var source = Wrap("func F() uint64 { return 18446744073709551615 }");
        Assert.Empty(Errors(source));
    }

    // ── A literal exceeding even uint64 must still error cleanly ────────

    [Theory]
    [InlineData("18446744073709551616")] // uint64.MaxValue + 1
    [InlineData("99999999999999999999999999")]
    public void LiteralExceedingUInt64_StillErrors(string value)
    {
        var source = Wrap("func F() uint64 { return " + value + " }");
        Assert.Contains(Errors(source), d => d.Id == "GS0004");
    }

    [Fact]
    public void OverInt32Literal_NarrowingBeyondTargetRange_StillErrors()
    {
        // 5000000000 infers int64; narrowing it into a uint32 (whose range it
        // exceeds) must remain an error per the #1183 constant-narrowing rule.
        var source = Wrap("func F() { var x uint32 = 5000000000 }");
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
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
