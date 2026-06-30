// <copyright file="Issue1465GenericSelfEncodingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1465 — inside the instance methods of a GENERIC class, references to
/// the class's own type parameters were mis-encoded in IL: the async/iterator
/// state-machine nested type was emitted as NON-generic, so <c>this</c>,
/// type-parameter-typed parameters, hoisted state-machine fields, and self/base
/// calls referenced a dangling <c>!0</c> (ilverify rendered <c>T0</c> /
/// <c>value 'T'</c>) instead of the class generic <c>ELEMENT_TYPE_VAR</c>. The
/// fix reifies the state-machine over ordinal-aligned copies of the enclosing
/// class's type parameters (any arity) and routes all dedicated raw-handle
/// token sites through generic-aware helpers. These tests assert the emitted IL
/// verifies clean and runs; each would fail ilverify on the pre-fix compiler.
/// </summary>
public class Issue1465GenericSelfEncodingEmitTests
{
    [Fact]
    public void EndToEnd_GenericClassAsyncSelfCall_VerifiesAndRuns()
    {
        var source = """
            package Probe1465a
            import System
            import System.Threading.Tasks

            open class FilterBase1465a[T] {
                open async func AddInputAsync(input T) {
                    await CompleteInternalAsync()
                }
                protected open async func CompleteInternalAsync() {
                    await FlushAsync()
                }
                protected open func FlushAsync() Task {
                    return Task.CompletedTask
                }
            }
            class AudioFilter1465a : FilterBase1465a[int32] {
            }
            func Main() {
                Console.WriteLine("ok")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void EndToEnd_GenericArity2ClassAsyncSelfCall_VerifiesAndRuns()
    {
        var source = """
            package Probe1465b
            import System
            import System.Threading.Tasks

            open class Pair1465b[K, V] {
                open async func ConsumeAsync(key K, value V) {
                    await ForwardAsync(key, value)
                }
                protected open async func ForwardAsync(key K, value V) {
                    await DoneAsync()
                }
                protected open func DoneAsync() Task {
                    return Task.CompletedTask
                }
            }
            class StringIntPair1465b : Pair1465b[string, int32] {
            }
            func Main() {
                Console.WriteLine("ok2")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok2\n", output);
    }

    [Fact]
    public void EndToEnd_IteratorInGenericClass_VerifiesAndRuns()
    {
        var source = """
            package Probe1465d
            import System
            import System.Collections.Generic

            open class Holder1465d[T] {
                var items []T
                func Init(a T, b T) {
                    items = [2]T
                    items[0] = a
                    items[1] = b
                }
                open func Enumerate() sequence[T] {
                    yield items[0]
                    yield items[1]
                }
            }
            func Main() {
                var h = Holder1465d[int32]()
                h.Init(5, 9)
                for x in h.Enumerate() {
                    Console.WriteLine(x)
                }
                Console.WriteLine("ok4")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n9\nok4\n", output);
    }

    [Fact]
    public void EndToEnd_BaseCallIntoGenericBase_VerifiesAndRuns()
    {
        var source = """
            package Probe1465c
            import System

            open class FrameFilterBase1465c[T] {
                open func Dispose(disposing bool) {
                    Console.WriteLine("base dispose")
                }
            }
            open class AavdFilterBase1465c : FrameFilterBase1465c[int32] {
            }
            class AavdFilter1465c : AavdFilterBase1465c {
                override func Dispose(disposing bool) {
                    base.Dispose(disposing)
                }
            }
            func Main() {
                var f = AavdFilter1465c()
                f.Dispose(true)
                Console.WriteLine("ok3")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("base dispose\nok3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1465_exe_").FullName;
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
