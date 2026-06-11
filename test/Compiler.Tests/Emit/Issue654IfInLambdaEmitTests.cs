// <copyright file="Issue654IfInLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #654: <c>if</c> statement inside a lambda body triggered GS9998
/// ("Bound statement kind 'IfStatement' is not yet supported by the emitter")
/// because lambda bodies (both capturing and non-capturing) were not run
/// through the <see cref="GSharp.Core.CodeAnalysis.Lowering.Lowerer"/> before
/// being stored in <c>lambdaBodies</c>. The Lowerer converts <c>IfStatement</c>
/// into <c>ConditionalGotoStatement</c> + <c>LabelStatement</c> which the
/// emitter already supports.
/// </summary>
public class Issue654IfInLambdaEmitTests
{
    #region if inside Task.Run lambda (original repro)

    [Fact]
    public void If_In_TaskRun_Lambda_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            Task.Run(func() {
                let x = 0
                if x > 0 {
                    return
                }
            }).Wait()
            Console.Write("ok")
            """;

        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("ok", stdout);
    }

    #endregion

    #region if/else inside synchronous closure lambda (captures outer var)

    [Fact]
    public void IfElse_In_Closure_Lambda_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System

            var result = ""
            var action = func() {
                let x = 42
                if x > 10 {
                    result = "big"
                } else {
                    result = "small"
                }
            }
            action()
            Console.Write(result)
            """;

        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("big", stdout);
    }

    #endregion

    #region nested if inside for inside lambda

    [Fact]
    public void NestedIf_In_For_In_Lambda_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System
            import System.Threading.Tasks

            var sum = 0
            Task.Run(func() {
                for i := 0; i < 5; i = i + 1 {
                    if i > 2 {
                        if i < 5 {
                            sum = sum + i
                        }
                    }
                }
            }).Wait()
            Console.Write(sum)
            """;

        // i=3 and i=4 satisfy both conditions → sum = 3 + 4 = 7
        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("7", stdout);
    }

    #endregion

    #region if inside non-capturing Func lambda (non-void return)

    [Fact]
    public void If_In_Func_Lambda_Compiles_And_Runs()
    {
        var source = """
            package Probe
            import System

            var compute = func(x int32) int32 {
                if x > 3 {
                    return x * 2
                }
                return x
            }
            Console.Write(compute(5))
            """;

        var (_, stdout) = CompileRunCapture(source);
        Assert.Equal("10", stdout);
    }

    #endregion

    #region Helpers

    private static (Assembly assembly, string stdout) CompileRunCapture(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_654_").FullName;
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
