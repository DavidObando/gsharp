// <copyright file="Issue2154CompoundOperatorOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2154 — issue #1554 taught compound assignment (<c>x op= y</c>) to
/// fall back to a USER-DEFINED <c>operator</c> overload the same way the
/// equivalent binary expression <c>x = x op y</c> does, but that fallback was
/// only reachable for a BARE local variable and for the built-in event-style
/// <c>+=</c>/<c>-=</c> operators on member access. The parser only emitted an
/// <see cref="GSharp.Core.CodeAnalysis.Syntax.EventSubscriptionExpressionSyntax"/>
/// (the node whose binder falls back to compound-assignment semantics for a
/// non-event member) for <c>+=</c>/<c>-=</c> — ANY other compound operator
/// (<c>*=</c>, <c>/=</c>, <c>%=</c>, <c>^=</c>, <c>&amp;=</c>, <c>|=</c>, ...)
/// on a member-access LHS (<c>obj.Field *= 2</c>, <c>Type.StaticField *= 2</c>,
/// <c>a.B.C *= 2</c>) failed to even PARSE (<c>GS0005 Unexpected token
/// &lt;StarEqualsToken&gt;</c>), even though the member's type declared a
/// matching <c>operator *</c> overload and <c>obj.Field = obj.Field * 2</c>
/// bound and ran fine.
/// <para>
/// The fix widens the parser's member-access compound-assignment gate from
/// <c>+=</c>/<c>-=</c>-only to ANY compound operator (mirroring the
/// already-generalized bare-identifier and indexer paths), and threads the
/// actual base operator kind through the binder's compound-assignment helpers
/// (previously hard-coded to a <c>bool isAdd</c> that only ever produced
/// <c>+</c>/<c>-</c>) so every LHS shape works uniformly for every compound
/// operator.
/// </para>
/// </summary>
public class Issue2154CompoundOperatorOverrideTests
{
    [Fact]
    public void EndToEnd_UserOperatorStarEquals_InstanceField_Runs()
    {
        const string source = """
            package i2154ifieldmul
            import System
            class VecD {
              var X int32
              var Y int32
            }
            func (a VecD) operator *(s int32) VecD {
              return VecD{X: a.X * s, Y: a.Y * s}
            }
            class HolderD { var V VecD }
            func Main() {
              var h = HolderD{}
              h.V = VecD{X: 2, Y: 3}
              h.V *= 3
              Console.WriteLine(h.V.X)
              Console.WriteLine(h.V.Y)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("6\n9\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorStarEquals_StaticField_Runs()
    {
        const string source = """
            package i2154sfieldmul
            import System
            struct MoneyT {
              var Cents int32
            }
            func (a MoneyT) operator *(s int32) MoneyT {
              return MoneyT{Cents: a.Cents * s}
            }
            class BankT {
              shared {
                var Total MoneyT
              }
            }
            func Main() {
              BankT.Total = MoneyT{Cents: 3}
              BankT.Total *= 4
              Console.WriteLine(BankT.Total.Cents)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorStarEquals_ChainedMember_Runs()
    {
        const string source = """
            package i2154chainmul
            import System
            struct VecE {
              var X int32
            }
            func (a VecE) operator *(s int32) VecE {
              return VecE{X: a.X * s}
            }
            class InnerE { var V VecE }
            class OuterE { var In InnerE }
            func Main() {
              var o = OuterE{In: InnerE{V: VecE{X: 2}}}
              o.In.V *= 5
              Console.WriteLine(o.In.V.X)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n", output);
    }

    [Fact]
    public void EndToEnd_UserOperatorSlashEquals_InstanceField_Runs()
    {
        const string source = """
            package i2154ifielddiv
            import System
            class VecF {
              var X int32
            }
            func (a VecF) operator /(s int32) VecF {
              return VecF{X: a.X / s}
            }
            class HolderF { var V VecF }
            func Main() {
              var h = HolderF{}
              h.V = VecF{X: 20}
              h.V /= 4
              Console.WriteLine(h.V.X)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    /// <summary>
    /// A real event on a member-access LHS must still bind as event
    /// subscription for <c>+=</c>/<c>-=</c> (regression guard: generalizing the
    /// parser/binder to accept any compound operator on a member-access LHS
    /// must not break the pre-existing event path).
    /// </summary>
    [Fact]
    public void EndToEnd_EventSubscription_MemberAccess_StillRuns()
    {
        const string source = """
            package i2154eventregress
            import System
            class ClickerG {
              event Clicked () -> void
              func Raise() {
                Clicked?.Invoke()
              }
            }
            func Main() {
              var c = ClickerG{}
              c.Clicked += func() { Console.WriteLine(1) }
              c.Raise()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2154_exe_").FullName;
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
}
