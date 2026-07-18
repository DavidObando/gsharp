// <copyright file="Issue2442ClosureCallableNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0069 amendment / issue #2442 — end-to-end compile + IL-verify + run
/// coverage for the closure-callable-narrowing fix: a nil-guard's smart-cast
/// narrowing on a read-only, plain-variable binding (a <c>let</c> local or a
/// by-value/<c>in</c> parameter) now survives into a captured lambda / local
/// function / async lambda body, and the emitted IL both verifies and
/// actually invokes the guarded delegate at runtime.
/// </summary>
public class Issue2442ClosureCallableNarrowingEmitTests
{
    [Fact]
    public void DownloadDecryptJobShape_NamedDelegateField_InvokesInsideTaskRunClosure()
    {
        var source = """
            package Issue2442Pkg
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            type ConvertFunc = delegate func(data []uint8) []uint8

            class DownloadDecryptJob {
                var runningTasks List[Task] = List[Task]()

                func Convert(data []uint8, convertAction ConvertFunc?) {
                    if convertAction != nil {
                        runningTasks.Add(Task.Run(() -> {
                            let result = convertAction(data)
                            Console.WriteLine(result.Length)
                        }))
                    }
                    for t in runningTasks {
                        t.Wait()
                    }
                }
            }

            var conv ConvertFunc = (data []uint8) -> { return []uint8{data[0] * 2} }
            let job = DownloadDecryptJob()
            job.Convert([]uint8{21}, conv)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void LetParameter_NamedDelegate_InvokedInsideArrowLambda()
    {
        var source = """
            package Issue2442Pkg
            import System

            type ConvertFunc = delegate func(data int32) int32

            func Run(convertAction ConvertFunc?, data int32) {
                if convertAction != nil {
                    let f = () -> { Console.WriteLine(convertAction(data)) }
                    f()
                }
            }

            var conv ConvertFunc = (x int32) -> { return x * 3 }
            Run(conv, 7)
            """;

        Assert.Equal("21\n", CompileAndRun(source));
    }

    [Fact]
    public void EscapingClosure_ReturnedAndInvokedAfterDeclaringFunctionReturns()
    {
        var source = """
            package Issue2442Pkg
            import System

            type ConvertFunc = delegate func(data int32) int32

            func Make(convertAction ConvertFunc?, data int32) (() -> void)? {
                if convertAction != nil {
                    return () -> { Console.WriteLine(convertAction(data)) }
                }
                return nil
            }

            var conv ConvertFunc = (x int32) -> { return x + 1 }
            let f = Make(conv, 41)
            if f != nil {
                f()
            }
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void AsyncLambda_InvokesAfterAwaitSuspension()
    {
        var source = """
            package Issue2442Pkg
            import System
            import System.Threading.Tasks

            type ConvertFunc = delegate func(data int32) int32

            func Run(convertAction ConvertFunc?, data int32) {
                if convertAction != nil {
                    let task = Task.Run(async () -> {
                        await Task.Delay(1)
                        Console.WriteLine(convertAction(data))
                    })
                    task.Wait()
                }
            }

            var conv ConvertFunc = (x int32) -> { return x * x }
            Run(conv, 6)
            """;

        Assert.Equal("36\n", CompileAndRun(source));
    }

    [Fact]
    public void MultipleClosures_CapturingSameReadOnlyBinding_BothInvokeCorrectly()
    {
        var source = """
            package Issue2442Pkg
            import System

            type ConvertFunc = delegate func(data int32) int32

            func Run(convertAction ConvertFunc?, data int32) {
                if convertAction != nil {
                    let f1 = () -> { Console.WriteLine(convertAction(data)) }
                    let f2 = () -> { Console.WriteLine(convertAction(data + 1)) }
                    f1()
                    f2()
                }
            }

            var conv ConvertFunc = (x int32) -> { return -x }
            Run(conv, 5)
            """;

        Assert.Equal("-5\n-6\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2442_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

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
