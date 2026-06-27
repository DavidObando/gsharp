// <copyright file="Issue1262DiscardParameterBinderTests.cs" company="GSharp">
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
/// Issue #1262 — a parameter list with more than one discard parameter named
/// <c>_</c> was wrongly rejected with GS0101 ("A parameter with the name '_'
/// already exists."). In C# <c>_</c> is a discard and repeated <c>_</c>
/// parameters are permitted (e.g. event handlers <c>(_, _) =&gt; ...</c>). G#
/// now allows repeated <c>_</c> discard parameters on both lambdas and named
/// functions/methods. Each <c>_</c> still occupies a positional slot but is not
/// added to the body's lookup scope, so referencing <c>_</c> does not bind to a
/// parameter and non-<c>_</c> duplicates still error.
/// </summary>
public class Issue1262DiscardParameterBinderTests
{
    [Fact]
    public void TwoDiscardLambdaParameters_NoGS0101()
    {
        var result = Evaluate("let h = (_ int32, _ int32) -> 0\n");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0101");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TwoDiscardNamedFunctionParameters_NoGS0101()
    {
        var result = Evaluate("func G(_ int32, _ int32) int32 { return 0 }\n");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0101");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void MixedDiscardAndNamedLambdaParameters_NamedStillResolves_NoGS0101()
    {
        var result = Evaluate("let h = (_ int32, x int32) -> x\n");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0101");
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void RealDuplicateLambdaParameters_StillReportsGS0101()
    {
        var result = Evaluate("let h = (x int32, x int32) -> 0\n");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0101");
    }

    [Fact]
    public void RealDuplicateNamedFunctionParameters_StillReportsGS0101()
    {
        var result = Evaluate("func G(x int32, x int32) int32 { return 0 }\n");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0101");
    }

    [Fact]
    public void ReferencingDiscardParameter_DoesNotBind_NoGS0101()
    {
        // `_` is a discard: it is not added to the body scope, so referencing it
        // does NOT resolve to a parameter. The reference is an undefined-name
        // error (GS0125), never GS0101.
        var result = Evaluate("let h = (_ int32) -> _ + 1\n");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0101");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0125");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var prelude = "import System\n";
        var syntaxTree = SyntaxTree.Parse(SourceText.From(prelude + source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
