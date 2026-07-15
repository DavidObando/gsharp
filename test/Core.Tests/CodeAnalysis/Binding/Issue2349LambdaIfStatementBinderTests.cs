// <copyright file="Issue2349LambdaIfStatementBinderTests.cs" company="GSharp">
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
/// Issue #2349 — binder-level coverage for the parser fix in
/// <c>Issue2349LambdaIfStatementParserTests</c>: a mid-body if/else
/// (terminated by a plain <c>else</c>) inside a lambda block body must bind
/// cleanly as a void if-STATEMENT, without the spurious GS0124 ("Expression
/// must have a value") that resulted from misclassifying it as a
/// value-producing if-EXPRESSION. Covers sync/async lambdas, nested blocks,
/// multiple mid-body if/else constructs, and the exact Oahu.Diagnostics
/// <c>rootCmd.SetAction</c> async-lambda shape (two independent mid-body
/// if/else blocks assigning/branching on a result, followed by a final
/// return), plus ordinary-function and tail-if-expression controls.
/// </summary>
public class Issue2349LambdaIfStatementBinderTests
{
    [Fact]
    public void MidBodyIfElse_VoidArms_NoGS0124()
    {
        var result = Evaluate(@"
let f = (cond bool) -> {
    if cond {
        Console.WriteLine(""a"")
    } else {
        Console.WriteLine(""b"")
    }
    Console.WriteLine(""c"")
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MidBodyIfElse_AssignmentArms_NoGS0124()
    {
        // Exact Oahu shape facet: both arms are assignment statements to an
        // already-declared local, not calls.
        var result = Evaluate(@"
let f = (doExport bool) -> {
    var report = """"
    if doExport {
        report = ""export""
    } else {
        report = ""run""
    }
    Console.WriteLine(report)
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MidBodyElseIfChain_VoidArms_NoGS0124()
    {
        var result = Evaluate(@"
let f = (n int32) -> {
    if n > 0 {
        Console.WriteLine(""p"")
    } else if n < 0 {
        Console.WriteLine(""n"")
    } else {
        Console.WriteLine(""z"")
    }
    Console.WriteLine(""done"")
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ExactOahuDiagnosticsShape_TwoMidBodyIfElseBlocks_ThenReturn_NoGS0124()
    {
        // The exact real-world shape from tools/Oahu.Diagnostics/Program.cs:
        // an async lambda (`rootCmd.SetAction(async (parse, ct) => { ... })`)
        // with two independent mid-body if/else blocks (each assigning a
        // result variable), followed by further statements and a final
        // `return` with an integer value.
        var result = Evaluate(@"
let handler = async (doExport bool, useJson bool) -> {
    var report = """"
    if doExport {
        report = ""export""
    } else {
        report = ""run""
    }

    if useJson {
        Console.WriteLine(""json: "" + report)
    } else {
        Console.WriteLine(""pretty: "" + report)
    }

    await Task.CompletedTask
    return 0
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NestedMidBodyIfElse_InsideOuterIfsThenBlock_NoGS0124()
    {
        var result = Evaluate(@"
let f = (a bool, b bool) -> {
    if a {
        if b {
            Console.WriteLine(""ab"")
        } else {
            Console.WriteLine(""a"")
        }
        Console.WriteLine(""after-inner"")
    } else {
        Console.WriteLine(""none"")
    }
    Console.WriteLine(""done"")
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AsyncLambda_MidBodyIfElse_NoGS0124()
    {
        var result = Evaluate(@"
let f = async (ok bool) -> {
    if ok {
        Console.WriteLine(""y"")
    } else {
        Console.WriteLine(""n"")
    }
    await Task.CompletedTask
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void SingleIdentifierArrowLambda_MidBodyIfElse_NoGS0124()
    {
        // Issue #932 single-identifier arrow-lambda shorthand `x -> { ... }`
        // shares the same block-expression parse path. A target type is
        // needed for the parameter to infer its type.
        var result = Evaluate(@"
let f Action[bool] = cond -> {
    if cond {
        Console.WriteLine(""y"")
    } else {
        Console.WriteLine(""n"")
    }
    Console.WriteLine(""done"")
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TailIfElse_StillValueProducing_ControlUnaffected()
    {
        // Control: a tail-position if/else (last item of the block) is still
        // a value-producing if-expression, unaffected by the fix.
        var result = Evaluate(@"
let f = (cond bool) -> {
    if cond { 1 } else { 2 }
}
Console.WriteLine(f(true))
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void OrdinaryFunction_MidBodyIfElse_ControlAlreadyWorks()
    {
        // Control: ordinary (non-lambda) functions parse their bodies via
        // ParseBlockStatement, never the block-expression if-expression
        // heuristic — mid-body if/else already worked there before this fix
        // and must continue to.
        var result = Evaluate(@"
func F(cond bool) {
    if cond {
        Console.WriteLine(""a"")
    } else {
        Console.WriteLine(""b"")
    }
    Console.WriteLine(""c"")
}
");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void LocalFunction_MidBodyIfElse_ControlAlreadyWorks()
    {
        // Control: a "local function" in G# is a lambda bound to a `let`
        // inside another function's body (no separate declaration syntax).
        // It shares the exact same block-expression parse path as any other
        // lambda and must be fixed identically.
        var result = Evaluate(@"
func Outer(cond bool) {
    let Inner = (c bool) -> {
        if c {
            Console.WriteLine(""a"")
        } else {
            Console.WriteLine(""b"")
        }
        Console.WriteLine(""c"")
    }
    Inner(cond)
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MidBodyIfWithoutElse_StillWorks_Regression()
    {
        // Regression guard: an if/else-if chain WITHOUT a terminating plain
        // else was already a void if-statement regardless of position
        // (issue #1172) — must remain unaffected.
        var result = Evaluate(@"
let f = () -> {
    if true {
        Console.WriteLine(""a"")
    }
    Console.WriteLine(""b"")
}
");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0124");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0276");
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var prelude = "import System\nimport System.Threading.Tasks\n";
        var syntaxTree = SyntaxTree.Parse(SourceText.From(prelude + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
