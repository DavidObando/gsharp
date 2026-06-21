// <copyright file="AsyncSpilledAwaitInTryEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression tests for a spilled <c>await</c> (an await appearing as a
/// sub-expression, e.g. a call argument) nested inside a <c>try</c> region —
/// including the <c>try</c>/<c>finally</c> that <c>using</c> lowers to.
/// <para>The <see cref="GSharp.Core.CodeAnalysis.Lowering.Async.SpillSequenceSpiller"/>
/// previously treated <c>BoundTryStatement</c> as an await-free leaf and never
/// descended into the protected block, so an await such as <c>F(await G())</c>
/// inside a <c>try</c>/<c>using</c> body was never lifted to statement
/// top-level. That left a raw <c>BoundAwaitExpression</c> in the synthesized
/// <c>MoveNext()</c> body, which the emitter rejected with
/// <c>GS9998: Bound expression kind 'AwaitExpression' is not yet supported by
/// the emitter.</c> These tests assert the program now emits, verifies, and
/// runs to the correct result.</para>
/// </summary>
public class AsyncSpilledAwaitInTryEmitTests
{
    [Fact]
    public void Spilled_Await_Inside_Using_Block_Emits_And_Runs()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            class Probe : IDisposable {
                init() {}
                func Dispose() {}
            }

            func AddAsync(a int32, b int32) Task[int32] {
                return Task.FromResult(a + b)
            }

            func Sum(a int32, b int32) int32 {
                return a + b
            }

            async func Compute() int32 {
                var total = 0
                using let p = Probe()
                total = Sum(await AddAsync(1, 2), await AddAsync(3, 4))
                return total
            }

            public var result = 0
            result = Compute().Result
            """;

        var assembly = CompileToAssembly(source);
        var program = assembly.GetType("<Program>") ?? FindProgram(assembly);
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        Assert.Equal(10, (int)resultField!.GetValue(null)!);
    }

    [Fact]
    public void Spilled_Await_Inside_TryCatch_Emits_And_Runs()
    {
        var source = """
            package P

            import System
            import System.Threading.Tasks

            func ValueAsync(n int32) Task[int32] {
                return Task.FromResult(n)
            }

            func Sum(a int32, b int32) int32 {
                return a + b
            }

            async func Compute() int32 {
                var total = 0
                try {
                    total = Sum(await ValueAsync(40), await ValueAsync(2))
                } catch (e Exception) {
                    total = -1
                }
                return total
            }

            public var result = 0
            result = Compute().Result
            """;

        var assembly = CompileToAssembly(source);
        var program = FindProgram(assembly);
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField("result", BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });

        Assert.Equal(42, (int)resultField!.GetValue(null)!);
    }

    private static Type FindProgram(Assembly assembly)
    {
        foreach (var t in assembly.GetTypes())
        {
            if (t.Name == "<Program>")
            {
                return t;
            }
        }

        throw new InvalidOperationException("No <Program> type found.");
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_async_spill_try_emit_").FullName;
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
        return Assembly.Load(bytes);
    }
}
