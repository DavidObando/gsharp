// <copyright file="TrailingLambdaTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 4.9 — Kotlin-style trailing-lambda call syntax. A
/// <c>func(...) {...}</c> literal that immediately follows a call's closing
/// paren attaches as that call's last positional argument. The bare-parens
/// form (no <c>()</c>) is intentionally out of scope; see
/// <see cref="Parser.MaybeAppendTrailingLambda"/>.
/// </summary>
public class TrailingLambdaTests
{
    [Fact]
    public void TrailingLambda_SoleArgument_DesugarsToCallArg()
    {
        var result = Evaluate(@"
func runIt(f () -> int32) int32 { return f() }
runIt() func() int32 { return 42 }
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TrailingLambda_WithPrecedingArgs_AppendsAsLast()
    {
        var result = Evaluate(@"
func combine(seed int32, f (int32) -> int32) int32 { return f(seed) }
combine(10) func(x int32) int32 { return x * 2 }
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void TrailingLambda_ZeroArityVoidReturn_Works()
    {
        var result = Evaluate(@"
var sum = 0
func apply(f () -> void) { f() }
apply() func() { sum = 5 }
sum
");
        // GS0286 (TLS must be contiguous, ADR-0066 D5) fires as a warning on
        // this helper-between-TLS layout; the test exercises evaluator
        // correctness, not the layout warning, so filter it.
        Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void TrailingLambda_MultipleParameters()
    {
        var result = Evaluate(@"
func reduce2(a int32, b int32, op (int32, int32) -> int32) int32 { return op(a, b) }
reduce2(3, 4) func(x int32, y int32) int32 { return x + y }
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void FuncDeclaration_FollowingCallStatement_StillParsesAsDeclaration()
    {
        // Regression: `func Name(...)` after a call must still parse as a
        // top-level function declaration, not get gobbled as a trailing
        // lambda. The lookahead `Peek(1).Kind == OpenParen` guard distinguishes
        // `func(` (literal) from `func Name(` (declaration).
        var result = Evaluate(@"
func Helper(x int32) int32 { return x + 1 }
Helper(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void TrailingLambda_ParseError_WhenLastParamIsNotFunctionType()
    {
        // If the trailing lambda is attached to a call whose last parameter is
        // not a function type, the binder reports the usual argument-type
        // mismatch.
        var result = Evaluate(@"
func takesInt(n int32) int32 { return n }
takesInt(1) func() int32 { return 0 }
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void TrailingLambda_AsyncSoleArgument_BindsWithoutDiagnostics()
    {
        // Verify the parser attaches `async func(...)` as a trailing lambda
        // (previously it misread `async` as an unexpected keyword and dropped
        // the literal from the argument list entirely).
        var result = Evaluate(@"
async func computeAsync() int32 { return 42 }
func runIt(f async () -> int32) { f() }
runIt() async func() int32 { return await computeAsync() }
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TrailingLambda_AsyncWithPrecedingArgs_BindsWithoutDiagnostics()
    {
        var result = Evaluate(@"
async func double(x int32) int32 { return x * 2 }
func combine(seed int32, f async (int32) -> int32) { f(seed) }
combine(10) async func(x int32) int32 { return await double(x) }
");
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
