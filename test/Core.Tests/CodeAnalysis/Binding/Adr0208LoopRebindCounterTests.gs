// <copyright file="Adr0208LoopRebindCounterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Tests
import System
import Xunit

/// ADR-0208 section 18: `narrowing.loop-rebinds` counts the loop bodies that the
/// design of that time binds twice. ADR-0213 slice L1 binds every loop once, so the counter is
/// always 0 (it is removed in slice L3).
open class Adr0208LoopRebindCounterTests {
    @Fact
    func ALoopWhoseWriteReachesTheBackEdge_BindsItsBodyOnce() {
        // Probe e4: `s = Get()` reaches the back edge, so the fact is removed
        // at the loop entry and the read of `s` is rejected. The body binds once.
        using let measurements = CompilationMeasurements.Start("test")
        let result = Evaluate(`package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    var total = 0
    while i < n {
        total = total + s.Length
        s = Get()
        i = i + 1
    }
    return total
}`)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Equal(0L, measurements.GetCounter("narrowing.loop-rebinds"))
    }

    @Fact
    func ALoopThatKeepsEveryInheritedFact_BindsItsBodyOnce() {
        using let measurements = CompilationMeasurements.Start("test")
        let result = Evaluate(`package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    var total = 0
    while i < n {
        total = total + s.Length
        i = i + 1
    }
    return total
}`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0L, measurements.GetCounter("narrowing.loop-rebinds"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}
