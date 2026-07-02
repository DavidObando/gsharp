// <copyright file="Issue1618IteratorFinallyOnThrowEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1618 — an iterator's <c>try { … yield … } finally { … }</c> was
/// lowered by removing the CLR protected region and inlining the try body
/// followed by the finally, so the finally only ran on NORMAL completion.
/// If the try body threw (after resuming from a yield), the exception
/// propagated out of <c>MoveNext</c> and the finally was silently skipped —
/// a P0 violation of try/finally semantics (user cleanup such as closing a
/// file or releasing a lock would never run).
/// <para>
/// The fix keeps the user try/finally as a real CLR protected region in
/// <c>MoveNext</c>, so the runtime itself guarantees the finally runs on
/// every exit path (normal completion, an exception, or an early
/// return/break), while a `yield` suspend-leave is told apart via a state
/// guard so it does NOT prematurely run the finally.
/// </para>
/// Each fact uses a UNIQUE package/type name because the in-process
/// <c>FunctionTypeSymbol</c> cache is name-keyed.
/// </summary>
public class Issue1618IteratorFinallyOnThrowEmitTests
{
    [Fact]
    public void Iterator_TryBodyThrowsAfterYield_RunsFinally_ThenPropagates()
    {
        // Runtime repro from the issue: `try { yield 1; Int32.Parse("boom") }
        // finally { ... }`, consumer catches. The finally must run even
        // though the try body throws instead of completing normally.
        const string source = """
            package i1618throw
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    Int32.Parse("boom")
                } finally {
                    Console.WriteLine("FINALLY RAN")
                }
            }

            func Main() int32 {
                try {
                    for v in gen() {
                        Console.WriteLine(v)
                    }
                } catch (e Exception) {
                    Console.WriteLine("caught")
                }
                Console.WriteLine("done")
                return 0
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nFINALLY RAN\ncaught\ndone\n", output);
    }

    [Fact]
    public void Iterator_TryFinally_NormalCompletion_RunsFinallyExactlyOnce()
    {
        const string source = """
            package i1618normal
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    yield 2
                } finally {
                    Console.WriteLine("FINALLY RAN")
                }
            }

            func Main() int32 {
                for v in gen() {
                    Console.WriteLine(v)
                }
                return 0
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\nFINALLY RAN\n", output);
    }

    [Fact]
    public void Iterator_TryFinally_EarlyBreak_RunsFinallyOnceViaDispose()
    {
        const string source = """
            package i1618break
            import System
            import System.Collections.Generic

            func gen() IEnumerable[int32] {
                try {
                    yield 1
                    yield 2
                    yield 3
                } finally {
                    Console.WriteLine("FINALLY RAN")
                }
            }

            func Main() int32 {
                for v in gen() {
                    Console.WriteLine(v)
                    if v == 1 {
                        break
                    }
                }
                return 0
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nFINALLY RAN\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1618_exe_").FullName;
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
