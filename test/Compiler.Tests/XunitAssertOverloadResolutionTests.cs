// <copyright file="XunitAssertOverloadResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Regression tests for issue #505: <c>Xunit.Assert.Equal("a","a")</c> was
/// reported as ambiguous (GS0160) because the binder's overload-ranking pass
/// did not implement C#'s full set of tie-breakers (non-generic-over-generic,
/// fewer-omitted-optionals). These tests compile a tiny G# library through
/// <c>gsc</c> against the host's real <c>xunit.assert.dll</c> so the resolved
/// candidates exactly match the xUnit overload surface users hit in practice.
/// </summary>
public class XunitAssertOverloadResolutionTests
{
    [Fact]
    public void AssertEqual_TwoStringArgs_ResolvesWithoutExplicitTypeArg()
    {
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func StringEq() {
                    Assert.Equal("hello", "hello")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoStringArgs_StillWorksWithExplicitTypeArg()
    {
        // Issue #505: callers that previously had to write the explicit
        // [string] type argument keep compiling unchanged.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func StringEqExplicit() {
                    Assert.Equal[string]("hello", "hello")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoIntLiterals_ResolveWithoutAmbiguity()
    {
        // Issue #505: integer literals must resolve to Equal<T>(T, T) with
        // T=int32 — the generic identity beats every numeric-widening overload.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func IntEq() {
                    Assert.Equal(1, 1)
                }
            }
            """);
    }

    [Fact]
    public void AssertNotEqual_TwoStringArgs_ResolveWithoutExplicitTypeArg()
    {
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func StringNotEq() {
                    Assert.NotEqual("a", "b")
                }
            }
            """);
    }

    private static void AssertGsCompilesCleanly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_xunit_overload_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Probe.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Probe.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            // The Compiler.Tests project already references xUnit, so its
            // trusted-platform-assemblies set contains xunit.assert.dll plus
            // the full BCL. Passing the closure forces the same
            // MetadataLoadContext reference path that real users hit when
            // gsc is driven through the SDK.
            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            Assert.True(File.Exists(outPath), "expected emitted assembly");
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
