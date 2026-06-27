// <copyright file="Issue1281ImplicitNumericCallSiteBinderTests.cs" company="GSharp">
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
/// Issue #1281: implicit numeric promotion at call sites.
///
/// G# already applies the implicit lossless-widening lattice (ADR-0044) at
/// call sites for both fixed parameters and generic inference. This adds the
/// remaining C# §10.2.11 rule: a <b>constant</b> integer argument whose value
/// fits a narrower / cross-sign integer parameter converts implicitly with no
/// cast — exactly as at a declaration target (ADR-0129). Non-constant
/// narrowing/cross-sign arguments and out-of-range constants stay an error.
/// </summary>
public class Issue1281ImplicitNumericCallSiteBinderTests
{
    // ── In-range constant argument narrows implicitly (fixed param) ────

    [Theory]
    [InlineData("uint16", "5")]
    [InlineData("uint16", "65535")]
    [InlineData("uint16", "0")]
    [InlineData("uint32", "5")]
    [InlineData("uint32", "4294967295")]
    [InlineData("uint8", "200")]
    [InlineData("int16", "100")]
    [InlineData("int16", "-30000")]
    [InlineData("int8", "-5")]
    public void InRangeConstantArgument_NarrowsImplicitly(string paramType, string value)
    {
        var source = @"
package p
func Take(x " + paramType + @") { }
func Use() { Take(" + value + @") }
";
        Assert.Empty(Errors(source));
    }

    [Fact]
    public void InRangeConstantArgument_UnaryNegated_NarrowsImplicitly()
    {
        var source = @"
package p
func Take(x int16) { }
func Use() { Take(-100) }
";
        Assert.Empty(Errors(source));
    }

    // ── Constructor / ctor-chaining argument narrows implicitly ────────

    [Fact]
    public void InRangeConstantArgument_ConstructorCall_NarrowsImplicitly()
    {
        var source = @"
package p
class Box(value uint16) { }
func Use() { let b = Box(42) }
";
        Assert.Empty(Errors(source));
    }

    // ── Generic user function with a constant-narrowing argument ────────

    [Fact]
    public void GenericUserFunction_ConstantArgument_UnifiesWithNarrowerArg()
    {
        // `tag` fixes T = uint16; the constant `5` then narrows to uint16.
        var source = @"
package p
func Pick[T](a T, b T) T { return a }
func Use(tag uint16) uint16 { return Pick(tag, 5) }
";
        Assert.Empty(Errors(source));
    }

    // ── Out-of-range / negative constant argument STILL errors ─────────

    [Theory]
    [InlineData("uint16", "70000")]
    [InlineData("uint16", "-1")]
    [InlineData("uint8", "300")]
    [InlineData("uint32", "-1")]
    [InlineData("int8", "200")]
    public void OutOfRangeConstantArgument_StillErrors(string paramType, string value)
    {
        var source = @"
package p
func Take(x " + paramType + @") { }
func Use() { Take(" + value + @") }
";
        Assert.Contains(Errors(source), d => d.Id == "GS0154");
    }

    // ── Non-constant narrowing / cross-sign argument STILL errors ──────

    [Fact]
    public void NonConstantNarrowingArgument_RequiresCast_Errors()
    {
        var source = @"
package p
func Take(x uint16) { }
func Use(n int32) { Take(n) }
";
        Assert.Contains(Errors(source), d => d.Id == "GS0154");
    }

    [Fact]
    public void NonConstantCrossSignArgument_RequiresCast_Errors()
    {
        var source = @"
package p
func Take(x uint32) { }
func Use(n int32) { Take(n) }
";
        Assert.Contains(Errors(source), d => d.Id == "GS0154");
    }

    // ── Non-constant lossless widening argument is implicit (regression)─

    [Theory]
    [InlineData("int32", "int64")]
    [InlineData("uint16", "int32")]
    [InlineData("uint8", "int32")]
    [InlineData("uint16", "uint32")]
    public void NonConstantWideningArgument_IsImplicit(string from, string to)
    {
        var source = @"
package p
func Take(x " + to + @") { }
func Use(n " + from + @") { Take(n) }
";
        Assert.Empty(Errors(source));
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
