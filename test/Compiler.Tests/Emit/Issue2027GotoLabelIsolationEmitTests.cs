// <copyright file="Issue2027GotoLabelIsolationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2027 (follow-up to #1884 / PR #2025): before this fix, a lambda or
/// local function that declared a <c>goto</c> label reusing the enclosing
/// function's label name shared a single <c>BoundLabel</c> across two
/// <c>MethodBody</c>s — an emitted <c>br</c> targeting a label in a
/// different method (invalid IL / <c>KeyNotFoundException</c> in
/// <c>MethodBodyPlanner.labels</c>). These emit-level tests pin that a
/// nested-frame <c>goto</c>/label declaring its own label matching an outer
/// name now compiles to valid IL and runs correctly — jumping only within
/// its own frame.
/// </summary>
public class Issue2027GotoLabelIsolationEmitTests
{
    [Fact]
    public void Lambda_OwnLabelMatchingOuterName_CompilesAndRunsCorrectly()
    {
        var source = """
            package Probe
            import System

            var order = ""
            order = order + "A"
            sameLabel:
            order = order + "B"

            let f = (x int32) -> {
                var innerOrder = ""
                goto sameLabel
                innerOrder = innerOrder + "skip"
                sameLabel:
                innerOrder = innerOrder + "C"
                return innerOrder
            }

            Console.Write(order)
            Console.Write(f(1))
            """;

        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("ABC", stdout);
    }

    [Fact]
    public void LocalFunction_OwnLabelMatchingOuterName_CompilesAndRunsCorrectly()
    {
        var source = """
            package Probe
            import System

            var order = ""
            order = order + "A"
            sameLabel:
            order = order + "B"

            let f = func() string {
                var innerOrder = ""
                goto sameLabel
                innerOrder = innerOrder + "skip"
                sameLabel:
                innerOrder = innerOrder + "C"
                return innerOrder
            }

            Console.Write(order)
            Console.Write(f())
            """;

        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("ABC", stdout);
    }

    #region Helpers

    private static (Assembly assembly, string stdout) CompileRunCapture(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2027_").FullName;
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
                "/target:exe",
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

        var bytes = File.ReadAllBytes(outPath);
        var assembly = Assembly.Load(bytes);

        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

        var captured = new StringWriter();
        var prevOut2 = Console.Out;
        Console.SetOut(captured);
        try
        {
            entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        }
        finally
        {
            Console.SetOut(prevOut2);
        }

        return (assembly, captured.ToString().Replace("\r\n", "\n"));
    }

    #endregion
}
