// <copyright file="Issue2933AsyncSelectArmBindingEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2933: Emitted-oracle coverage for async select arm binding.
open class Issue2933AsyncSelectArmBindingEmittedOracleTests {
    @Fact
    func EmittedOraclePreservesAsyncSelectReceiveBinding() {
        const Source = `
async func Run() int32 {
    let ch = chan[int32](1)
    ch <- 3
    var result = 0
    select {
        case let value = <-ch { result = 7 + value }
    }
    return result
}

Run().GetAwaiter().GetResult()`
        let result = EmittedOracle.Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }
}
