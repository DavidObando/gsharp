// <copyright file="Issue1918ValueTaskAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1918: two related gaps in <c>System.Threading.Tasks.ValueTask[T]</c>
/// support. (a) An <c>async func</c> whose return-type clause explicitly spells
/// <c>ValueTask[T]</c> / <c>ValueTask</c> (instead of the implicit-wrap bare
/// <c>T</c> / <c>void</c> form) previously failed to bind: the declared
/// <c>ValueTask[T]</c> was used, unwrapped, as the return-statement's target
/// type, so <c>return v * 3</c> reported GS0155 ("cannot convert 'int32' to
/// 'ValueTask&lt;int32&gt;'") followed by GS0100 ("not all code paths return a
/// value"). (b) Awaiting a directly-constructed <c>ValueTask[T]</c> ICE'd with
/// GS9998 ("NotSupportedException: Derived classes must provide an
/// implementation.") under the SDK build path (MetadataLoadContext-loaded
/// references), because the async lowering / observable-return-type machinery
/// only recognized the <c>Task</c> / <c>Task[T]</c> wrapper shapes. Both are
/// fixed by unwrapping an explicit <c>Task</c>/<c>ValueTask</c> wrapper at the
/// async declaration to its awaited result (recording which wrapper was
/// requested), and by threading that choice through the state-machine builder
/// resolution and the call-site's observable return type.
/// </summary>
public class Issue1918ValueTaskAsyncEmitTests
{
    [Fact]
    public void AsyncFunc_ReturningValueTaskOfT_WrapsReturnValue()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func TripleAsync(v int32) ValueTask[int32] {
                await Task.CompletedTask
                return v * 3
            }

            var r = TripleAsync(5).Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("15\n", output);
    }

    [Fact]
    public void AsyncFunc_ReturningBareValueTask_CompletesWithoutValue()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func NoteAsync(label string) ValueTask {
                await Task.CompletedTask
                Console.WriteLine(label)
            }

            NoteAsync("done").AsTask().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("done\n", output);
    }

    [Fact]
    public void Await_DirectlyConstructedValueTaskOfT_ReturnsValue()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func RunAsync() Task {
                var ready ValueTask[int32] = ValueTask[int32](5)
                var five int32 = await ready
                Console.WriteLine(five)
            }

            RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void Await_DirectlyConstructedBareValueTask_Completes()
    {
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func RunAsync() Task {
                var done ValueTask = ValueTask.CompletedTask
                await done
                Console.WriteLine("completed")
            }

            RunAsync().Wait()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("completed\n", output);
    }

    [Fact]
    public void AsyncFunc_ReturningValueTaskOfT_CallsRealAsyncIoLikeMethod()
    {
        // "I/O-like" via Task.Delay, mirroring how a real ValueTask-returning
        // async method would await a genuinely-async completion source rather
        // than an already-completed one.
        var source = """
            package P
            import System
            import System.Threading.Tasks

            async func FetchAsync(v int32) ValueTask[int32] {
                await Task.Delay(1)
                return v + 1
            }

            var r = FetchAsync(41).Result
            Console.WriteLine(r)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1918_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
