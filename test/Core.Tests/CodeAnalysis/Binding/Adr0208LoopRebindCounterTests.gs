// <copyright file="Adr0208LoopRebindCounterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Tests
import System
import System.Reflection
import Xunit

/// ADR-0213 sections 15 and 20 (slices L1 and L3): loops bind once after applying the syntactic
/// region lower bound `Lower(S, R)`, `narrowing.loop-rebinds` is retired, and the dead L0/L1/L2
/// comparison and narrowing helpers are removed.
open class Adr0208LoopRebindCounterTests {
    @Fact
    func ALoopWhoseWriteReachesTheBackEdge_BindsItsBodyOnce() {
        // Probe e4: `s = Get()` is in the loop region, so the fact is removed
        // at the loop entry and the read of `s` is rejected. The region is walked once.
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
        Assert.Equal(1L, measurements.GetCounter("narrowing.region-walks"))
        Assert.Equal(1L, measurements.GetCounter("narrowing.region-facts-killed"))
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
        Assert.Equal(1L, measurements.GetCounter("narrowing.region-walks"))
        Assert.Equal(0L, measurements.GetCounter("narrowing.region-facts-killed"))
    }

    @Fact
    func SliceL3_RetiresLoopComparisonAndDeadNarrowingHelpers() {
        let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        Assert.Null(typeof(StatementBinder).Assembly.GetType("GSharp.Core.CodeAnalysis.Binding.NarrowingComparison"))
        let statementBinderType = typeof(StatementBinder)
        for retiredBinderMethod in[]string{
            "ApplyIfJoinNarrowings",
            "ApplyEarlyExitNarrowings",
            "RestoreEarlyExitLiftsWrittenOnlyByCondition",
            "ComputeIfJoinNonNull",
            "ComputeBranchFallthroughNonNull",
            "ProcessBranchStatement",
            "ReportBackwardJumpSpan",
            "FindBangSitesAfter",
            "CollectBangSites",
            "IsRepresentationPreservingJoin",
            "RemoveByRoots",
            "ClrPropertyReadRunsUserCode",
            "HasActiveNarrowings",
            "BindLabeledForRange"
        } {
            Assert.Empty(statementBinderType.GetMember(retiredBinderMethod, flags))
        }
        let jumpStateType = typeof(NarrowingJumpState)
        Assert.Empty(jumpStateType.GetMember("ActiveFinallyClauses", flags))
        Assert.Empty(jumpStateType.GetMember("ActiveCleanupStatements", flags))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}
