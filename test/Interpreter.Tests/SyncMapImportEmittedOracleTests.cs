// <copyright file="SyncMapImportEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0158 / issue #3209: G#-side consumption of
/// <c>Gsharp.Extensions.Sync.SyncMap[K, V]</c> through real emitted
/// execution — `import Gsharp.Extensions.Sync`, construct, and hammer from
/// goroutines. The concurrent-increment test is the language-level
/// successor of the deleted Issue1799 racy-increment shape (#3205's
/// original repro), now exact because <c>Update</c> is atomic.
/// C#-side behavioral coverage lives in
/// <c>test/Extensions.Tests/SyncMapTests.cs</c>.
/// </summary>
public class SyncMapImportEmittedOracleTests
{
    [Fact]
    public void SyncMap_BasicSurface_FromGsharp()
    {
        var source = """
            import Gsharp.Extensions.Sync

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

            run()
            """;

        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(100 + 40 + 2 + 0 + 2 + 100 + 2 + 42, result.Value);
    }

    [Fact]
    public void SyncMap_GoroutineIncrements_AreExact()
    {
        // The #3205 repro shape (50 goroutines bumping one key of a shared
        // map inside a scope), which lost updates on a plain map — spelled
        // with SyncMap.Update the count is exactly 50 every run.
        var source = """
            import Gsharp.Extensions.Sync

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

            run()
            """;

        var result = Evaluate(source);
        AssertNoRealDiagnostics(result);
        Assert.Equal(50, result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        // Same host-assembly seeding as Issue750ConstraintOverloadEmittedOracleTests:
        // the Compilation.Default reference resolver enumerates loaded
        // assemblies, so anchor the extensions assembly via typeof and
        // Assembly.LoadFrom the on-disk Gsharp.Extensions.dll for .NET 10's
        // lazy test host.
        _ = typeof(Gsharp.Extensions.Sync.SyncMap<,>);

        var extPath = LocateGsharpExtensionsAssembly();
        if (extPath != null)
        {
            try
            {
                System.Reflection.Assembly.LoadFrom(extPath);
            }
            catch
            {
            }
        }

        // ADR-0082 / issue #722: `go` is gated behind this import.
        var fullSource = source;
        return EmittedOracle.Evaluate(fullSource);
    }

    private static string LocateGsharpExtensionsAssembly()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(SyncMapImportEmittedOracleTests).Assembly.Location));
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                foreach (var cfg in new[] { "Debug", "Release" })
                {
                    var candidate = Path.Combine(dir.FullName, "out", "bin", cfg, "Gsharp.Extensions", "Gsharp.Extensions.dll");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }

                return null;
            }

            dir = dir.Parent;
        }

        return null;
    }

    /// <summary>
    /// GS0286 (ADR-0066 D5) flags declaration-before-use ordering as a
    /// warning, not an error — same allowance as the sibling concurrency
    /// suites.
    /// </summary>
    private static void AssertNoRealDiagnostics(EmittedOracleResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Id != "GS0286");
    }
}
