// <copyright file="Issue1904AsyncEntryPointEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1904 — an <c>async</c> entry point (either the synthesized
/// top-level-statement <c>&lt;Main&gt;$</c> when a top-level <c>await</c> is
/// present, or a user-authored <c>async func Main()</c>) used to emit a
/// <c>Task</c>/<c>Task&lt;T&gt;</c>-returning CLR entry point. The runtime
/// rejects that at process start with
/// <c>MethodAccessException: "Entry point must have a return type of void,
/// integer, or unsigned integer."</c> — a SILENT divergence (gsc compiles and
/// ilverifies the assembly fine; only running it fails).
/// <para>
/// The fix: when the async kickoff method is also the CLR entry point, the
/// emitter no longer returns <c>builder.Task</c> — it blocks on it right there
/// with the same <c>GetAwaiter().GetResult()</c> drive C# generates for
/// <c>async Task Main()</c>, and the CLR signature stays the function's
/// declared void/int32 shape.
/// </para>
/// Each fact uses a UNIQUE package name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed (see Issue1502 emit tests).
/// </summary>
public class Issue1904AsyncEntryPointEmitTests
{
    [Fact]
    public void TopLevelAwait_EntryPoint_RunsAndReturnsVoid()
    {
        const string source = """
            package i1904tlsvoid
            import System
            import System.Threading.Tasks

            Console.WriteLine("start")
            await Task.Delay(1)
            Console.WriteLine("end")
            """;

        var output = CompileAndRun(source, expectedExitCode: 0);
        Assert.Equal("start\nend\n", output);
    }

    [Fact]
    public void TopLevelAwait_EntryPoint_ReturnValue_BecomesProcessExitCode()
    {
        const string source = """
            package i1904tlsint
            import System
            import System.Threading.Tasks

            Console.WriteLine("start")
            await Task.Delay(1)
            return 42
            """;

        var output = CompileAndRun(source, expectedExitCode: 42);
        Assert.Equal("start\n", output);
    }

    [Fact]
    public void ExplicitTopLevelAsyncFuncMain_Void_RunsAndReturnsVoid()
    {
        const string source = """
            package i1904explicitvoid
            import System
            import System.Threading.Tasks

            async func Main() {
                Console.WriteLine("start")
                await Task.Delay(1)
                Console.WriteLine("end")
            }
            """;

        var output = CompileAndRun(source, expectedExitCode: 0);
        Assert.Equal("start\nend\n", output);
    }

    [Fact]
    public void ExplicitTopLevelAsyncFuncMain_Int_ReturnValueBecomesProcessExitCode()
    {
        const string source = """
            package i1904explicitint
            import System
            import System.Threading.Tasks

            async func Main() int32 {
                Console.WriteLine("start")
                await Task.Delay(1)
                return 7
            }
            """;

        var output = CompileAndRun(source, expectedExitCode: 7);
        Assert.Equal("start\n", output);
    }

    [Fact]
    public void ExplicitTopLevelAsyncFuncMain_WithArgsParameter_Runs()
    {
        const string source = """
            package i1904explicitargs
            import System
            import System.Threading.Tasks

            async func Main(args []string) {
                Console.WriteLine(args.Length)
                await Task.Delay(1)
            }
            """;

        var output = CompileAndRun(source, expectedExitCode: 0);
        Assert.Equal("0\n", output);
    }

    /// <summary>
    /// Copied verbatim from <c>Issue1502DelegateUserTypeArgEmitTests.CompileAndRun</c>
    /// (test/Compiler.Tests/Emit/Issue1502DelegateUserTypeArgEmitTests.cs),
    /// with the hard-coded <c>proc.ExitCode == 0</c> assertion parameterized so
    /// this suite can also prove an async entry point's <c>return N</c> becomes
    /// the real CLR process exit code (issue #1904).
    /// </summary>
    private static string CompileAndRun(string source, int expectedExitCode)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1904_exe_").FullName;
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
                proc.ExitCode == expectedExitCode,
                $"expected exit {expectedExitCode}, got {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
