// <copyright file="Issue2854TopLevelEllipsisLoopCaptureInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2854 interpreter guard for top-level numeric ellipsis loop captures.
/// </summary>
public class Issue2854TopLevelEllipsisLoopCaptureInterpreterTests
{
    [Fact]
    public void TopLevelClosureCapturesIterationVariable()
    {
        var tree = SyntaxTree.Parse(
            """
            var callback = () -> { return -1 }

            for i in 0 ... 1 {
                callback = () -> { return i }
            }

            let result = callback()
            result
            """);
        var result = new Compilation(tree).Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }
}
