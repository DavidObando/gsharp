// <copyright file="Issue2906ExhaustiveSwitchStatementEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2906: Emitted-oracle coverage for exhaustive switch statement.
open class Issue2906ExhaustiveSwitchStatementEmittedOracleTests {
    @Fact
    func SealedInterfaceNil_FallsThroughToFollowingReturn() {
        const Source = `sealed interface Expr { }
class Literal : Expr { }
func F(x Expr) int32 {
    switch x {
        case _ is Literal { return 1 }
    }
    return 0
}
F(default(Expr))`
        let result = EmittedOracle.Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }
}
