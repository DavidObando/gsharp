// <copyright file="Issue1246CompoundAssignWideningBinderTests.cs" company="GSharp">
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
/// Issue #1246: a compound assignment <c>lhs op= rhs</c> must apply the SAME
/// implicit lossless numeric widening (and constant-integer-literal adaptation)
/// to the right operand that the binary operator <c>lhs op rhs</c> applies, then
/// convert the result back to the LHS type for the store. Before the fix the
/// underlying operator was bound against the RAW operand types, so
/// <c>int32 += uint8</c> failed GS0129 even though <c>a = a + b</c> compiled.
///
/// The non-widening direction (LHS strictly narrower than the result, e.g.
/// <c>uint8 += int32</c>) must STILL be rejected, exactly as
/// <c>u = u + i</c> is — the final assignment conversion back to the LHS type
/// guards against silent narrowing.
/// </summary>
public class Issue1246CompoundAssignWideningBinderTests
{
    // ── Positive: RHS widens into the LHS integer type ─────────────────

    [Theory]
    [InlineData("int32", "uint8")]
    [InlineData("int32", "int8")]
    [InlineData("int32", "uint16")]
    [InlineData("int32", "int16")]
    [InlineData("int64", "int32")]
    [InlineData("int64", "uint16")]
    [InlineData("int64", "uint32")]
    [InlineData("int16", "uint8")]
    public void PlusEquals_RhsWidensToLhs_NoDiagnostics(string lhs, string rhs)
    {
        var source = CompoundBody("+=", lhs, rhs);
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("+=")]
    [InlineData("-=")]
    [InlineData("*=")]
    [InlineData("/=")]
    [InlineData("%=")]
    [InlineData("&=")]
    [InlineData("|=")]
    [InlineData("^=")]
    public void AllArithmeticAndBitwiseCompound_Int64WithInt32_NoDiagnostics(string op)
    {
        var source = CompoundBody(op, "int64", "int32");
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("<<=")]
    [InlineData(">>=")]
    public void ShiftCompound_Int64WithInt32_NoDiagnostics(string op)
    {
        var source = CompoundBody(op, "int64", "int32");
        Assert.Empty(Errors(source));
    }

    // ── Positive: untyped constant integer literal adapts to the LHS ───

    [Fact]
    public void Int64PlusEqualsIntLiteral_NoDiagnostics()
    {
        var source = Wrap(@"func F() int64 {
        var x int64 = 0
        x += 1
        return x
    }");
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void UInt8PlusEqualsInRangeLiteral_NoDiagnostics()
    {
        var source = Wrap(@"func F() uint8 {
        var u uint8 = 0
        u += 5
        return u
    }");
        Assert.Empty(Errors(source));
    }

    // ── Negative: narrowing direction stays an error (C# semantics) ────

    [Fact]
    public void UInt8PlusEqualsInt32_StillErrors()
    {
        // Mirrors `u = u + i`, whose result int32 does not implicitly convert
        // back to uint8 — a cast would be required.
        var source = Wrap(@"func F() uint8 {
        var u uint8 = 0
        var i int32 = 300
        u += i
        return u
    }");
        Assert.NotEmpty(Errors(source));
    }

    [Fact]
    public void UInt8PlusEqualsOutOfRangeLiteral_StillErrors()
    {
        var source = Wrap(@"func F() uint8 {
        var u uint8 = 0
        u += 300
        return u
    }");
        Assert.NotEmpty(Errors(source));
    }

    [Fact]
    public void Int32PlusEqualsUInt32_NeitherWidens_StillErrors()
    {
        // int32 and uint32 are mutually non-implicit, so neither operand
        // widens to the other — consistent with the binary `a + b` behaviour.
        var source = Wrap(@"func F() int32 {
        var a int32 = 0
        var b uint32 = 3
        a += b
        return a
    }");
        Assert.NotEmpty(Errors(source));
    }

    private static string CompoundBody(string op, string lhs, string rhs)
    {
        return Wrap(@"func F() " + lhs + @" {
        var a " + lhs + @" = 1
        var b " + rhs + @" = 1
        a " + op + @" b
        return a
    }");
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
