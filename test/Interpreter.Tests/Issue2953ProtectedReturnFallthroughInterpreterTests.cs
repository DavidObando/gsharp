// <copyright file="Issue2953ProtectedReturnFallthroughInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2953: protected-region return funnels must not manufacture a default
/// return value when an exhaustive enum switch misses an unnamed runtime value.
/// </summary>
public class Issue2953ProtectedReturnFallthroughInterpreterTests
{
    [Fact]
    public void ProtectedReturnFunnel_UnnamedEnumValue_ReportsGS0100()
    {
        const string Source = """
            import System

            func F(x DateTimeKind) int32 {
                try {
                    switch x {
                        case DateTimeKind.Unspecified { return 1 }
                        case DateTimeKind.Utc { return 2 }
                        case DateTimeKind.Local { return 3 }
                    }
                } finally { }
            }

            F(DateTimeKind(99))
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0100", diagnostic.Id);
        Assert.Equal(
            "Compiler-generated guard reached: non-void function fell through without returning a value.",
            diagnostic.Message);
        Assert.Null(result.Value);
    }
}
