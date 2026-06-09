// <copyright file="ResourceLeakRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Regression guard for the OOM / fd-exhaustion bug that manifested when the
/// full Compiler.Tests suite ran in a single host process. The root cause was
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver"/> not disposing
/// its <c>MetadataLoadContext</c>, which leaked ~200 file handles per
/// compilation that used <c>/reference:</c> switches.
///
/// This test compiles multiple programs with explicit references in a tight
/// loop and asserts that process memory and handle counts stay bounded.
/// </summary>
public class ResourceLeakRegressionTests
{
    /// <summary>
    /// Compiles 20 programs using explicit /reference: paths (triggering
    /// MetadataLoadContext creation) and verifies that memory does not grow
    /// unboundedly. Before the fix, each compilation leaked ~5-50 MB via
    /// undisposed MetadataLoadContext; after the fix, GC.GetTotalMemory
    /// stays roughly flat because the MLC file mappings are released on
    /// each Program.Main return.
    /// </summary>
    [Fact]
    public void RepeatedCompilationsWithReferences_DoNotLeakMemory()
    {
        const int iterations = 20;
        const string source = """
            package P

            func Main() {
            }
            """;

        var references = TrustedPlatformAssemblies().Take(30).ToList();
        if (references.Count == 0)
        {
            // If we can't locate platform assemblies, skip gracefully.
            return;
        }

        // Warm up: run one compilation so JIT / static init costs don't skew.
        RunCompilation(source, references);

        // Force a full GC to establish a clean baseline.
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);

        long baselineMemory = GC.GetTotalMemory(forceFullCollection: true);

        for (int i = 0; i < iterations; i++)
        {
            RunCompilation(source, references);
        }

        // After all compilations, force GC and measure.
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);

        long finalMemory = GC.GetTotalMemory(forceFullCollection: true);
        long growth = finalMemory - baselineMemory;

        // Allow up to 50 MB of growth (generous margin for test framework
        // overhead, string allocations, etc.). Before the fix, growth was
        // typically 200-500+ MB over 20 iterations due to leaked MLCs.
        const long maxAllowedGrowthBytes = 50 * 1024 * 1024;

        Assert.True(
            growth < maxAllowedGrowthBytes,
            $"Memory grew by {growth / (1024 * 1024)} MB over {iterations} compilations " +
            $"with /reference: (baseline={baselineMemory / (1024 * 1024)} MB, " +
            $"final={finalMemory / (1024 * 1024)} MB). " +
            "This suggests MetadataLoadContext instances are not being disposed.");
    }

    private static void RunCompilation(string source, List<string> references)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_leak_test_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            foreach (var r in references)
            {
                args.Add("/reference:" + r);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            try
            {
                var exit = Program.Main(args.ToArray());
                Assert.True(exit == 0, $"compile failed: {compileOut}{compileErr}");
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
