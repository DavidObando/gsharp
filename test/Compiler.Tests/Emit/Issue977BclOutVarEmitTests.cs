// <copyright file="Issue977BclOutVarEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #977: an inline <c>out var</c>/<c>out let</c>/<c>out _</c> argument must
/// bind against imported (BCL) method overloads, not only user-defined functions.
/// The defect made <c>d.TryGetValue("a", out var v)</c> fail overload resolution
/// (<c>GS0159 Cannot find function TryGetValue</c>) even though the equivalent
/// pre-declared pass-by-address (<c>&amp;slot</c>) and user-function forms bound
/// fine. These tests cover the imported-method instance-call path:
/// <list type="bullet">
/// <item><description>The local declared by <c>out var v</c> is inferred from the
/// chosen overload's by-ref parameter (e.g. <c>int32</c> for
/// <c>Dictionary[string,int32].TryGetValue(TKey, out TValue)</c>).</description></item>
/// <item><description>Type inference is per-instantiation (<c>int32</c> vs
/// <c>string</c>).</description></item>
/// <item><description>The pre-declared <c>&amp;slot</c> control and the
/// user-function <c>out var</c> control keep compiling (no regression).</description></item>
/// <item><description><c>out _</c> discard against a BCL method also binds.</description></item>
/// </list>
/// </summary>
public class Issue977BclOutVarEmitTests
{
    [Fact]
    public void Dictionary_IntValue_InlineOutVar_HitAndMiss()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["a"] = 5
            let ok = d.TryGetValue("a", out var v)
            Console.WriteLine(ok)
            Console.WriteLine(v)
            let miss = d.TryGetValue("z", out var w)
            Console.WriteLine(miss)
            Console.WriteLine(w)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n5\nFalse\n0\n", output);
    }

    [Fact]
    public void Dictionary_IntValue_InlineOutVar_LocalIsInferredInt32()
    {
        // The inferred local participates in int32 arithmetic, proving the type
        // was inferred from the `out TValue` parameter (int32), not left as Error.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["a"] = 20
            d.TryGetValue("a", out var v)
            let doubled int32 = v * 2
            Console.WriteLine(doubled)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("40\n", output);
    }

    [Fact]
    public void Dictionary_StringValue_InlineOutVar_PerInstantiationInference()
    {
        // A second instantiation infers `string` for the same `out var` shape,
        // confirming inference is driven by the constructed receiver type.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let sd = Dictionary[string, string]()
            sd["x"] = "hello"
            let ok = sd.TryGetValue("x", out var s)
            Console.WriteLine(ok)
            Console.WriteLine(s)
            Console.WriteLine(s.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nhello\n5\n", output);
    }

    [Fact]
    public void Dictionary_PreDeclaredAddressOf_Control_StillCompiles()
    {
        // Control: BCL out via a pre-declared local passed by address (&slot).
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["a"] = 7
            var slot int32
            let ok = d.TryGetValue("a", &slot)
            Console.WriteLine(ok)
            Console.WriteLine(slot)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n7\n", output);
    }

    [Fact]
    public void UserFunc_InlineOutVar_Control_StillCompiles()
    {
        // Control: a user-defined func with an `out` parameter + inline out var.
        var source = """
            package P
            import System

            func tryProduce(out result int32) bool {
                result = 42
                return true
            }

            let ok = tryProduce(out var n)
            Console.WriteLine(ok)
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n42\n", output);
    }

    [Fact]
    public void Dictionary_InlineOutDiscard_AgainstBclMethod()
    {
        // `out _` discard against a BCL method must also bind and run.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d["a"] = 9
            let ok = d.TryGetValue("a", out _)
            Console.WriteLine(ok)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue977_emit_").FullName;
        try
        {
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

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
