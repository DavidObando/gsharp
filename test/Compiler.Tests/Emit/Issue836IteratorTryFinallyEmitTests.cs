// <copyright file="Issue836IteratorTryFinallyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #836 — end-to-end emit + IL-verify coverage for iterator
/// state machines whose user body contains <c>try</c>/<c>finally</c>
/// around <c>yield</c>. Asserts both the runtime behaviour (full
/// enumeration runs the finally once, early-break runs the finally
/// during Dispose) and that the synthesized state machine passes
/// <c>dotnet-ilverify</c> on net10.0.
/// </summary>
public class Issue836IteratorTryFinallyEmitTests
{
    [Fact]
    public void Iterator_TryFinally_FullEnumeration_RunsFinallyOnce()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    yield 10
                    yield 20
                } finally {
                    Console.WriteLine("dispose")
                }
            }

            public var sum = 0
            public var disposeMarker = ""
            for v in gen() {
                sum = sum + v
            }
            disposeMarker = "ok"
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(30, GetIntField(assembly, "sum"));
        Assert.Equal("ok", GetStringField(assembly, "disposeMarker"));
    }

    [Fact]
    public void Iterator_TryFinally_EarlyBreak_RunsFinallyOnDispose()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            public var finallyRan = 0
            public var seen = 0

            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    yield 2
                    yield 3
                } finally {
                    finallyRan = finallyRan + 1
                }
            }

            for v in gen() {
                seen = seen + 1
                if v == 1 {
                    break
                }
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(1, GetIntField(assembly, "seen"));
        Assert.Equal(1, GetIntField(assembly, "finallyRan"));
    }

    [Fact]
    public void Iterator_NestedTryFinally_EarlyBreak_RunsInnerThenOuter()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            public var trace = ""

            func gen() IEnumerable[int32] {
                try {
                    try {
                        yield 1
                        yield 2
                    } finally {
                        trace = trace + "I"
                    }
                } finally {
                    trace = trace + "O"
                }
            }

            for v in gen() {
                if v == 1 {
                    break
                }
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal("IO", GetStringField(assembly, "trace"));
    }

    [Fact]
    public void Iterator_TryFinally_FullEnumeration_FinallyExactlyOnce()
    {
        var source = """
            package Probe
            import System
            import System.Collections.Generic

            public var finallyRan = 0

            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    yield 2
                    yield 3
                } finally {
                    finallyRan = finallyRan + 1
                }
            }

            for v in gen() {
                // consume
            }
            """;

        var assembly = CompileAndRun(source);
        Assert.Equal(1, GetIntField(assembly, "finallyRan"));
    }

    #region Helpers

    private static Assembly CompileAndRun(string source)
    {
        var outPath = CompileToFile(source, target: "exe");

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        return assembly;
    }

    private static string CompileToFile(string source, string target)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_836_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static int GetIntField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (int)field!.GetValue(null)!;
    }

    private static string GetStringField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var field = program.GetField(name, BindingFlags.Public | BindingFlags.Static);
        return (string)field!.GetValue(null)!;
    }

    #endregion
}
