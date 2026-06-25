// <copyright file="Issue1172ArrowLambdaParityBinderTests.cs" company="GSharp">
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
/// ADR-0128 / issue #1172 — a block-bodied arrow lambda <c>(p) -&gt; { … }</c> is
/// now a STATEMENT block with an optional trailing value expression, reaching parity
/// with func literals. An <c>if</c> WITHOUT a matching <c>else</c> inside the block
/// is a void if-STATEMENT (no longer rejected with GS0276 as a value-position
/// if-expression). These binder tests pin the FAILS-today cases (now clean) and the
/// WORKS-today regression guards, plus the distinction that a value-position block
/// (not a lambda body) ending in a void <c>if</c> still has no value.
/// </summary>
public class Issue1172ArrowLambdaParityBinderTests
{
    [Fact]
    public void NonTrailingIfWithoutElse_VoidStatement_NoGS0276()
    {
        var result = Evaluate(@"
let f = (x int32) -> { if x > 0 { Console.WriteLine(""a"") }
return x * 2 }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TrailingIfWithoutElse_VoidActionLambda_NoGS0276()
    {
        var result = Evaluate(@"
let f = (x int32) -> { if x > 0 { Console.WriteLine(""a"") } }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void EarlyReturnInsideIfWithoutElse_NoGS0276()
    {
        var result = Evaluate(@"
let f = (x int32) -> { if x < 0 { return 0 }
return x * 2 }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NonTrailingIfWithoutElse_ThenTrailingValue_NoGS0276()
    {
        var result = Evaluate(@"
let f = (x int32) -> { if x > 0 { Console.WriteLine(""p"") }
let z = x * 2
z }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitFuncTargetType_IfWithoutElse_NoGS0276()
    {
        var result = Evaluate(@"
let g Func[int32, int32] = (x int32) -> { if x > 0 { return x }
return 0 }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedIfWithoutElse_InnerIfWithElse_NoGS0276()
    {
        var result = Evaluate(@"
let f = (x int32) -> { if x > 0 { if x > 10 { Console.WriteLine(""big"") } else { Console.WriteLine(""small"") } }
x }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TrailingIfWithElse_AsValue_StillBindsCleanly()
    {
        var result = Evaluate(@"
let f = (x int32) -> { if x > 0 { ""pos"" } else if x < 0 { ""neg"" } else { ""zero"" } }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ElseIfChainWithoutFinalElse_VoidStatement_NoGS0276()
    {
        // An `if`/`else if` chain WITHOUT a terminating plain `else` has a path
        // that yields no value, so it is a void if-STATEMENT (parity with func
        // literals) — not a value-position if-expression rejected with GS0276.
        var result = Evaluate(@"
let g = (y int32) -> { if y > 0 { Console.WriteLine(""p"") } else if y < 0 { Console.WriteLine(""n"") } }
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ElseIfChainTerminatingPlainElse_AsValue_StillBindsCleanly()
    {
        // An `if`/`else if` chain that DOES terminate in a plain `else` is a
        // value-producing if-expression and must still bind cleanly.
        var result = Evaluate(@"
let g = (y int32) -> { if y > 0 { 1 } else if y < 0 { 2 } else { 3 } }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TrailingExpressionValueBlock_StillBindsCleanly()
    {
        var result = Evaluate(@"
let f = (x int32) -> { let y = x + 1
y * 2 }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NonTrailingVoidCall_ThenTrailingValue_StillBindsCleanly()
    {
        var result = Evaluate(@"
let f = (x int32) -> { Console.WriteLine(""hi"")
x * 2 }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ExplicitReturnOnly_StillBindsCleanly()
    {
        var result = Evaluate(@"
let f = (x int32) -> { return x * 2 }
");

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void IfExpression_InLetInit_MissingElse_StillReportsGS0276()
    {
        // Regression guard: an `if` used directly as a value (NOT inside a
        // block-expression item) is still a value-position if-expression and
        // must have an `else`. The parser look-ahead only reclassifies `if`
        // inside a block expression.
        var result = Evaluate(@"
let x = if true { 1 }
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0276");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var prelude = "import System\nimport System.Threading.Tasks\n";
        var syntaxTree = SyntaxTree.Parse(SourceText.From(prelude + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
