// <copyright file="Issue2906ExhaustiveSwitchStatementEmittedOracleTests.cs" company="GSharp">
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
/// Issue #2906: Emitted-oracle coverage for exhaustive switch statement.
/// </summary>
public class Issue2906ExhaustiveSwitchStatementEmittedOracleTests
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
