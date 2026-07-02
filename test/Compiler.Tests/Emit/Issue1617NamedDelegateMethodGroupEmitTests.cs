// <copyright file="Issue1617NamedDelegateMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1617 (drift 3): <c>EmitMethodGroupToNamedDelegate</c> — the emit path
/// for binding a method group to a user-declared (named) <c>delegate</c> type —
/// was missing two fixes that its twin <c>EmitMethodGroup</c> already carried:
/// <list type="bullet">
/// <item>#1397: an INTERFACE-typed receiver must dispatch via <c>ldvirtftn</c>
/// (not <c>ldftn</c>) so the delegate invokes the concrete implementation
/// through interface dispatch.</item>
/// <item>#1467: a receiver of a user-declared GENERIC type must resolve the
/// function token through a MemberRef parented at the constructed receiver
/// TypeSpec, because a bare MethodDef of a method on a generic type is not a
/// valid delegate-ctor function token (ilverify <c>DelegateCtor</c>).</item>
/// </list>
/// Both shapes previously emitted an invalid function token — failing ilverify
/// and/or throwing at runtime — and both now verify and invoke the correct
/// method. Each test uses UNIQUE type/delegate names because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
///
/// <para>The interface-receiver case below was previously blocked by issue
/// #1716 — a separate, pre-existing MethodDef row-reservation ordering bug —
/// and skipped until that was fixed. See
/// <see cref="Issue1716DelegateOverInterfaceRowReservationEmitTests"/> for a
/// standalone regression test covering the general row-reservation fix
/// itself.</para>
/// </summary>
public class Issue1617NamedDelegateMethodGroupEmitTests
{
    [Fact]
    public void EndToEnd_NamedDelegate_MethodGroupOverInterfaceReceiver_Runs()
    {
        const string source = """
            package i1617ifacemg
            import System

            interface IGreeter1617 {
                func Greet() string;
            }

            class Greeter1617 : IGreeter1617 {
                func Greet() string { return "hello-1617" }
            }

            type StringFn1617 = delegate func() string

            func Main() {
                var g IGreeter1617 = Greeter1617()
                var d StringFn1617 = g.Greet
                System.Console.WriteLine(d.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello-1617\n", output);
    }

    [Fact]
    public void EndToEnd_NamedDelegate_MethodGroupOverGenericReceiver_Runs()
    {
        const string source = """
            package i1617genmg
            import System

            class Box1617[T] {
                var value T
                var tag int32
                init(v T, t int32) {
                    value = v
                    tag = t
                }
                func Tag() int32 { return tag }
            }

            type IntFn1617 = delegate func() int32

            func Main() {
                var b = Box1617[int32](42, 7)
                var d IntFn1617 = b.Tag
                System.Console.WriteLine(d.Invoke())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1617mg_exe_").FullName;
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
