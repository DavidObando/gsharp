// <copyright file="Issue2853EllipsisLoopCaptureInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2853 interpreter guard for numeric ellipsis loop capture semantics.
/// </summary>
public class Issue2853EllipsisLoopCaptureInterpreterTests
{
    [Fact]
    public void ClosureCapturesValueFromCreatingIteration()
    {
        var tree = SyntaxTree.Parse(
            """
            func capture() int32 {
                var callback = () -> { return -1 }

                for i in 0 ... 3 {
                    if i == 0 { callback = () -> { return i } }
                }

                return callback()
            }

            capture()
            """);
        var result = new Compilation(tree).Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }
}
