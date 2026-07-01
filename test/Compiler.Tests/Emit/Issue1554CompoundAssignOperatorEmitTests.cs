// <copyright file="Issue1554CompoundAssignOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1554 — compound assignment <c>x op= y</c> only resolved the BUILT-IN
/// binary operator; it did NOT fall back to USER-DEFINED
/// (<c>func (a T) operator +(b U) R</c>) or CLR (<c>op_*</c>, e.g.
/// <c>TimeSpan.op_Addition</c>) operator resolution the way the equivalent
/// binary expression <c>x = x op y</c> does. So <c>x += y</c> reported GS0129 for
/// any type whose operator is user-defined or a BCL operator, even though
/// <c>x + y</c> bound fine.
/// <para>
/// The fix routes <see cref="M:GSharp.Binding.ExpressionBinder.TryBindCompoundBinaryOperation"/>
/// through the same user/CLR operator fallback the binary path uses (a shared
/// helper), so every compound-assignment target kind (local, instance field,
/// static field, chained member) works uniformly for user and BCL operators.
/// </para>
/// Each test uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed for user types.
/// </summary>
public class Issue1554CompoundAssignOperatorEmitTests
{
    [Fact]
    public void EndToEnd_TimeSpanPlusEquals_Local_Runs()
    {
        const string source = """
            package i1554tsadd
            import System
            func Main() {
              var x = TimeSpan.FromSeconds(int64(1))
              x += TimeSpan.FromSeconds(int64(2))
              Console.WriteLine(x.TotalSeconds)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void EndToEnd_TimeSpanMinusEquals_Local_Runs()
    {
        const string source = """
            package i1554tssub
            import System
            func Main() {
              var x = TimeSpan.FromSeconds(int64(5))
              x -= TimeSpan.FromSeconds(int64(2))
              Console.WriteLine(x.TotalSeconds)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void EndToEnd_DateTimePlusEqualsTimeSpan_Local_Runs()
    {
        const string source = """
            package i1554dtadd
            import System
            func Main() {
              var d = DateTime(2020, 1, 1, 0, 0, 0)
              d += TimeSpan.FromDays(float64(5))
              Console.WriteLine(d.Day)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorPlusEquals_Local_Runs()
    {
        const string source = """
            package i1554vecadd
            import System
            class VecA {
              var X int32
              var Y int32
            }
            func (a VecA) operator +(b VecA) VecA {
              return VecA{X: a.X + b.X, Y: a.Y + b.Y}
            }
            func Main() {
              var p = VecA{X: 1, Y: 2}
              p += VecA{X: 3, Y: 4}
              Console.WriteLine(p.X)
              Console.WriteLine(p.Y)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n6\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorStarEquals_Local_Runs()
    {
        const string source = """
            package i1554moneymul
            import System
            struct MoneyM {
              var Cents int32
            }
            func (a MoneyM) operator *(b MoneyM) MoneyM {
              return MoneyM{Cents: a.Cents * b.Cents}
            }
            func Main() {
              var m = MoneyM{Cents: 3}
              m *= MoneyM{Cents: 4}
              Console.WriteLine(m.Cents)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorPlusEquals_InstanceField_Runs()
    {
        const string source = """
            package i1554ifield
            import System
            class VecB {
              var X int32
              var Y int32
            }
            func (a VecB) operator +(b VecB) VecB {
              return VecB{X: a.X + b.X, Y: a.Y + b.Y}
            }
            class HolderB { var V VecB }
            func Main() {
              var h = HolderB{}
              h.V = VecB{X: 1, Y: 2}
              h.V += VecB{X: 3, Y: 4}
              Console.WriteLine(h.V.X)
              Console.WriteLine(h.V.Y)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n6\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorPlusEquals_StaticField_Runs()
    {
        const string source = """
            package i1554sfield
            import System
            struct MoneyS {
              var Cents int32
            }
            func (a MoneyS) operator +(b MoneyS) MoneyS {
              return MoneyS{Cents: a.Cents + b.Cents}
            }
            class BankS {
              shared {
                var Total MoneyS
              }
            }
            func Main() {
              BankS.Total = MoneyS{Cents: 3}
              BankS.Total += MoneyS{Cents: 4}
              Console.WriteLine(BankS.Total.Cents)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorPlusEquals_ChainedMember_Runs()
    {
        const string source = """
            package i1554chain
            import System
            struct VecC {
              var X int32
            }
            func (a VecC) operator +(b VecC) VecC {
              return VecC{X: a.X + b.X}
            }
            class InnerC { var V VecC }
            class OuterC { var In InnerC }
            func Main() {
              var o = OuterC{In: InnerC{V: VecC{X: 1}}}
              o.In.V += VecC{X: 10}
              Console.WriteLine(o.In.V.X)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("11\n", output);
    }

    [Fact]
    public void EndToEnd_Int32PlusEquals_Local_StillRuns()
    {
        const string source = """
            package i1554i32
            import System
            func Main() {
              var i int32 = 10
              i += 5
              Console.WriteLine(i)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void EndToEnd_DecimalPlusEquals_Local_StillRuns()
    {
        const string source = """
            package i1554dec
            import System
            func Main() {
              var d decimal = decimal(10)
              d += decimal(5)
              Console.WriteLine(d)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void CompileOnly_Uint8PlusEqualsInt32_StillRejected()
    {
        const string source = """
            package i1554u8reject
            import System
            func Main() {
              var b uint8 = uint8(1)
              var i int32 = 5
              b += i
              Console.WriteLine(b)
            }
            """;

        var (exit, output) = CompileOnly(source);
        Assert.NotEqual(0, exit);
        Assert.True(
            output.Contains("GS0129") || output.Contains("GS0156"),
            $"expected a compound-assignment rejection diagnostic, got:\n{output}");
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1554_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Output) CompileOnly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1554_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (compileExit, stdoutWriter + stderrWriter.ToString());
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
