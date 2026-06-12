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
