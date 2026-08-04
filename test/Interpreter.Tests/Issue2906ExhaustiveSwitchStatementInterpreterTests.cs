// <copyright file="Issue2906ExhaustiveSwitchStatementInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2906: exhaustive switch statements still fall through when no
/// runtime pattern matches.
/// </summary>
public class Issue2906ExhaustiveSwitchStatementInterpreterTests
{
    [Fact]
    public void SealedInterfaceNil_FallsThroughToFollowingReturn()
    {
        const string Source = """
            sealed interface Expr { }
            class Literal : Expr { }
            func F(x Expr) int32 {
                switch x {
                    case _ is Literal { return 1 }
                }
                return 0
            }
            F(nil)
            """;

        var result = EmittedOracle.Evaluate(Source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }
}
