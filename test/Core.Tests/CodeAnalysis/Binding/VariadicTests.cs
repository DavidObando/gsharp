// <copyright file="VariadicTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 4.8 — variadic parameters (<c>func f(xs ...T)</c>). Inside the
/// body the parameter has type <c>[]T</c>; at call sites trailing
/// arguments are packed into a slice. Interpreter-only for now.
/// </summary>
public class VariadicTests
{
    [Fact]
    public void Variadic_PacksTrailingArgs_IntoSlice()
    {
        var result = Evaluate(@"
func sum(nums ...int32) int32 {
    var total = 0
    for var i = 0; i < len(nums); i++ {
        total = total + nums[i]
    }
    return total
}
sum(1, 2, 3, 4)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Variadic_AcceptsZeroTrailingArgs_EmptySlice()
    {
        var result = Evaluate(@"
func count(xs ...int32) int32 { return len(xs) }
count()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Variadic_WithFixedParametersBefore()
    {
        var result = Evaluate(@"
func joinWith(sep string, parts ...string) string {
    var s = """"
    for var i = 0; i < len(parts); i++ {
        if i > 0 { s = s + sep }
        s = s + parts[i]
    }
    return s
}
joinWith("", "", ""a"", ""b"", ""c"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("a, b, c", result.Value);
    }

    [Fact]
    public void Variadic_TooFewFixedArgs_ReportsDiagnostic()
    {
        var result = Evaluate(@"
func joinWith(sep string, parts ...string) string { return sep }
joinWith()
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_WrongElementType_ReportsDiagnostic()
    {
        var result = Evaluate(@"
func sum(nums ...int32) int32 { return 0 }
sum(1, ""x"", 3)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_NotLastParameter_ReportsDiagnostic()
    {
        var result = Evaluate(@"
func bad(xs ...int32, n int32) int32 { return n }
bad(1, 2)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Variadic_OnLambda_ReportsNotSupported()
    {
        var result = Evaluate(@"
let f = func(xs ...int32) int32 { return 0 }
f()
");
        Assert.NotEmpty(result.Diagnostics);
    }

    // ADR-0101 / issue #799 — issue repro: `Sequences.Of`-shaped generic
    // variadic. Declared in source as `func Of[T](values ...T) []T` so the
    // test exercises every branch (multi-arg pack, single-array pass-through,
    // empty pack) without depending on the C#-authored helper.

    [Fact]
    public void Variadic_Generic_PacksTrailingArgs()
    {
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let xs = Of(1, 2, 3)
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_Generic_SingleArrayPassesThrough()
    {
        // Issue #799 §3 (call-site semantics): when the caller supplies a
        // single trailing argument already typed `[]T`, it must be passed
        // through as-is — no double-wrap.
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let arr = []int32{10, 20, 30}
let xs = Of(arr)
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Variadic_Generic_EmptyCall_ProducesEmptySlice()
    {
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let xs = Of[int32]()
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Variadic_Generic_PassThrough_PreservesIdentity()
    {
        // The pass-through path means the body sees the SAME array the
        // caller supplied — index 1 of the returned slice equals the
        // value the caller stored at index 1 of the input.
        var result = Evaluate(@"
func Of[T](values ...T) []T { return values }
let arr = []int32{100, 200, 300}
let xs = Of(arr)
xs[1]
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(200, result.Value);
    }

    [Fact]
    public void Variadic_MultipleVariadicParameters_Diagnostic()
    {
        // ADR-0101 / issue #799: at most one variadic param per signature.
        var result = Evaluate(@"
func bad(xs ...int32, ys ...int32) int32 { return 0 }
bad(1)
");
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0364");
    }

    [Fact]
    public void Variadic_ParamsKeyword_Rejected()
    {
        // ADR-0101 / issue #799: the C# `params` keyword is intentionally
        // not part of the G# grammar. The parser flags the spelling
        // and points the user at the canonical `...T` form.
        var result = Evaluate(@"
func bad(params values []int32) int32 { return 0 }
bad()
");
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0363");
    }

    private static EvaluationResult Evaluate(string source)
    {
        // ADR-0083 / issue #723: prepend the Go extensions import so the
        // `len(...)` calls inside variadic-helper test sources keep
        // binding rather than tripping the GS0317 gate. The unused import
        // is silent when a test happens not to call any gated built-in.
        var syntaxTree = SyntaxTree.Parse(SourceText.From("import Gsharp.Extensions.Go\n" + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
