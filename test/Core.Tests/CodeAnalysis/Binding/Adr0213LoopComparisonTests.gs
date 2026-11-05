// <copyright file="Adr0213LoopComparisonTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0213 sections 15 and 20 (slice L3): the slice-L0 `.loops` comparison report (`K`, `T`, `X`, `S`
/// lines and the `path.loops` file) is retired, while `GSHARP_NARROWING_COMPARE` retains only the
/// ADR-0208 join (`J`) and read (`R`) reports and `CompilationMeasurements` retains the section 15
/// region and span counters.
open class Adr0213LoopComparisonTests {
    @Fact
    func NarrowingComparison_DoesNotEmitLoopOrSpanReportLines() {
        NarrowingComparison.BeginCapture()
        var lines = List[string]()
        try {
            Evaluate(`package T
func Get(c bool) string? { return if c { nil } else { "ab" } }
func Run(c bool, n int32) int32 {
    var s string? = Get(c)
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + 1
    }
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = nil
    }
    var m string? = Get(c)
    while m == nil {
        m = "ok"
    }
    total = total + m!!.Length
    var k = 0
    var p string? = Get(c)
    if p == nil { return total }
    Again: k = k + p!!.Length
    p = nil
    if k < n { p = Get(c); goto Again }
    return total + k
}`)
        } finally {
            lines = NarrowingComparison.EndCapture()
        }
        let nonShadowLines = lines.Where(
            (line string) -> !line.StartsWith("J\t", StringComparison.Ordinal) && !line.StartsWith(
                "R\t",
                StringComparison.Ordinal
            )
        )
            .ToArray()
        Assert.Empty(nonShadowLines)
    }

    @Fact
    func FlushTo_WritesOnlyJoinAndReadReports_AndNoLoopsFile() {
        let path = Path.Combine(AppContext.BaseDirectory, "gs_adr0213_l3_" + Guid.NewGuid().ToString("N"))
        try {
            NarrowingComparison.FlushTo(path)
            Assert.True(File.Exists(path))
            Assert.True(File.Exists(path + ".reads"))
            Assert.False(File.Exists(path + ".loops"))
        } finally {
            if File.Exists(path) {
                File.Delete(path)
            }
            if File.Exists(path + ".reads") {
                File.Delete(path + ".reads")
            }
            if File.Exists(path + ".loops") {
                File.Delete(path + ".loops")
            }
        }
    }

    @Fact
    func ASpanInALoopWhoseFactIsRemovedIsReportedOnce() {
        // The first label sits in a loop whose fact the lower bound removes. The loop binds once, and the span
        // is counted once without needing comparison capture.
        using let measurements = CompilationMeasurements.Start("test")
        Evaluate(`package T

func Get() string? { return nil }

func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var i = 0
    while i < n {
        i = i + s.Length
        s = nil
        Again: i = i + 1
        if i < 3 { goto Again }
        s = Get()
        if s == nil { return 0 }
    }
    return i
}`)
        Assert.Equal(1L, measurements.GetCounter("narrowing.spans"))
    }

    @Fact
    func AFunctionWithOnlyAForwardJumpCountsNoSpan() {
        using let measurements = CompilationMeasurements.Start("test")
        Evaluate(`package T
func Run(skip bool) int32 {
    if skip { goto Done }
    Done: return 1
}`)
        Assert.Equal(0L, measurements.GetCounter("narrowing.spans"))
    }

    @Fact
    func TheCountersOfSection15AreReported() {
        using let measurements = CompilationMeasurements.Start("test")
        Evaluate(`package T
class C { var Value int32 = 1 }
func Run(n int32) int32 {
    var x C? = C{}
    let clear = func() { x = nil }
    if x == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + x.Value
    }
    clear()
    return total
}
func Get() string? { return nil }
func Other(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    for var i = 0; i < n; i++ {
        s = nil
    }
    return n
}`)
        Assert.True(measurements.GetCounter("narrowing.region-walks") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-nodes") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-member-reads") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-member-reads-with-live-facts") > 0L)
        Assert.True(measurements.GetCounter("narrowing.region-facts-killed") > 0L)
    }

    @Fact
    func TheReportDoesNotChangeTheDiagnostics() {
        // The mode reads the binder state. A program with a rejected read and a loop reports the same diagnostics.
        let source = `package T
func Get() string? { return nil }
func Run(n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        total = total + s.Length
        s = Get()
    }
    return total + s.Length
}`
        let plain = Evaluate(source)
        NarrowingComparison.BeginCapture()
        var compared EmittedOracleResult
        try {
            compared = Evaluate(source)
        } finally {
            NarrowingComparison.EndCapture()
        }
        Assert.NotEmpty(plain.Diagnostics)
        Assert.Equal(
            plain.Diagnostics.Select((d Diagnostic) -> d.ToString()).ToArray(),
            compared.Diagnostics.Select((d Diagnostic) -> d.ToString()).ToArray()
        )
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(
                []string{source},
                EmittedOracleOptions{IsLibrary: !source.Contains("func Main")}
            )
        }
    }
}
