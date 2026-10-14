// <copyright file="SyncMapImportEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// ADR-0158 / issue #3209: G#-side consumption of
/// `Gsharp.Extensions.Sync.SyncMap[K, V]` through real emitted
/// execution — `import Gsharp.Extensions.Sync`, construct, and hammer from
/// goroutines. The concurrent-increment test is the language-level
/// successor of the deleted Issue1799 racy-increment shape (#3205's
/// original repro), now exact because `Update` is atomic.
/// C#-side behavioral coverage lives in
/// `test/Extensions.Tests/SyncMapTests.cs`.
open class SyncMapImportEmittedOracleTests {
    @Fact
    func SyncMap_BasicSurface_FromGsharp() {
        let source = `import Gsharp.Extensions.Sync

func run() int32 {
    var m = SyncMap[string, int32]()
    m.Store("a", 40)
    m.Store("b", 2)
    m.Store("gone", 99)

    var total = 0
    if m.Delete("gone") {
        total = total + 100
    }

    total = total + m.Load("a") + m.Load("b")   // 40 + 2
    total = total + m.Load("missing")           // + zero value
    total = total + m.Length()                     // + 2
    if m.Contains("a") {
        total = total + 100
    }

    // Note: across the imported-assembly boundary Keys()'s
    // []K binds as a CLR array (string[]), so size is read
    // via .Length rather than the len builtin.
    total = total + m.Keys().Length             // + 2

    var sum = 0
    m.Range(func(k string, v int32) {
        sum = sum + v
    })
    total = total + sum                         // + 42

    return total
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(100 + 40 + 2 + 0 + 2 + 100 + 2 + 42, result.Value)
    }

    @Fact
    func SyncMap_GoroutineIncrements_AreExact() {
        // The #3205 repro shape (50 goroutines bumping one key of a shared
        // map inside a scope), which lost updates on a plain map — spelled
        // with SyncMap.Update the count is exactly 50 every run.
        let source = `import Gsharp.Extensions.Sync

func bump(m SyncMap[string, int32]) int32 {
    m.Update("k", func(v int32) int32 { return v + 1 })
    return 0
}

func run() int32 {
    var m = SyncMap[string, int32]()
    scope {
        for var i = 0; i < 50; i++ {
            go bump(m)
        }
    }

    return m.Load("k")
}

run()`
        let result = Evaluate(source)
        AssertNoRealDiagnostics(result)
        Assert.Equal(50, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            let extPath string? = LocateGsharpExtensionsAssembly()
            if extPath != nil {
                try {
                    Assembly.LoadFrom(extPath)
                } catch { }
            }
            // ADR-0082 / issue #722: `go` is gated behind this import.
            let fullSource = source
            return EmittedOracle.Evaluate(fullSource)
        }

        private func LocateGsharpExtensionsAssembly() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(SyncMapImportEmittedOracleTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    for cfg in[]string{"Debug", "Release"} {
                        let candidate = Path.Combine(
                            dir.FullName,
                            "out",
                            "bin",
                            cfg,
                            "Gsharp.Extensions",
                            "Gsharp.Extensions.dll"
                        )
                        if File.Exists(candidate) {
                            return candidate
                        }
                    }
                    return nil
                }
                dir = dir.Parent
            }
            return nil
        }

        /// GS0286 (ADR-0066 D5) flags declaration-before-use ordering as a
        /// warning, not an error — same allowance as the sibling concurrency
        /// suites.
        private func AssertNoRealDiagnostics(result EmittedOracleResult) {
            Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id != "GS0286")
        }
    }
}
