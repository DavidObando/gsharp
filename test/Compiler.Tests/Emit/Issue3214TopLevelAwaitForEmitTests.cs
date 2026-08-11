// <copyright file="Issue3214TopLevelAwaitForEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3214 — a statement-level top-level await (<c>await for … { }</c>,
/// <c>await using …</c>) carries its <c>await</c> as a keyword on the
/// statement syntax, so the ADR-0066 D3 pre-scan that flags the synthesized
/// <c>&lt;Main&gt;$</c> as async never saw it: the entry point stayed
/// synchronous and emit failed with GS9998 ("AwaitExpression is not yet
/// supported by the emitter") once the await-for lowering introduced its
/// <c>MoveNextAsync</c> awaits. The pre-scan now recognizes the statement
/// forms, and the existing #1904 async-entry machinery (state-machine
/// lowering plus the synchronous kickoff drive) does the rest. These facts
/// run the real <c>gsc</c>-compiled process — the file-mode surface.
/// Each fact uses a UNIQUE package name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed (see Issue1502 emit tests).
/// </summary>
public class Issue3214TopLevelAwaitForEmitTests
{
    [Fact]
    public void TopLevelAwaitFor_DrainsAsyncEnumerable_AndExitsZero()
    {
        const string source = """
            package i3214awaitfor
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Counts() IAsyncEnumerable[int32] {
                yield 1
                await Task.Yield()
                yield 2
                await Task.Yield()
                yield 3
            }

            var total = 0
            await for v in Counts() {
                total = total + v
            }
            Console.WriteLine(total)
            """;

        var output = CompileAndRun(source, expectedExitCode: 0);
        Assert.Equal($"6{Environment.NewLine}", output);
    }

    [Fact]
    public void TopLevelAwaitFor_ReturnValue_BecomesProcessExitCode()
    {
        const string source = """
            package i3214awaitforexit
            import System.Collections.Generic
            import System.Threading.Tasks

            async func Counts() IAsyncEnumerable[int32] {
                yield 20
                await Task.Yield()
                yield 22
            }

            var total = 0
            await for v in Counts() {
                total = total + v
            }
            return total
            """;

        CompileAndRun(source, expectedExitCode: 42);
    }

    [Fact]
    public void TopLevelAwaitUsing_DisposesAsynchronously()
    {
        const string source = """
            package i3214awaitusing
            import System
            import System.Threading.Tasks

            class Resource : IAsyncDisposable {
                func DisposeAsync() ValueTask {
                    Console.WriteLine("disposed")
                    return ValueTask.CompletedTask
                }
            }

            {
                await using let r = Resource{}
                Console.WriteLine("body")
            }
            Console.WriteLine("after")
            """;

        var output = CompileAndRun(source, expectedExitCode: 0);
        Assert.Equal($"body{Environment.NewLine}disposed{Environment.NewLine}after{Environment.NewLine}", output);
    }

    /// <summary>
    /// Copied verbatim from <c>Issue1904AsyncEntryPointEmitTests.CompileAndRun</c>
    /// (test/Compiler.Tests/Emit/Issue1904AsyncEntryPointEmitTests.cs): compiles
    /// with the real gsc driver, ilverifies, and runs the produced executable
    /// out-of-process so the CLR's entry-point signature validation is part of
    /// the assertion surface.
    /// </summary>
    private static string CompileAndRun(string source, int expectedExitCode)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3214_exe_").FullName;
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
