// <copyright file="Issue4341GoClosureAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4341: synthesized goroutine helpers retain the lexical member's
/// private/protected accessibility domain.
/// </summary>
public class Issue4341GoClosureAccessEmitTests
{
    [Fact]
    public void DirectGoCallsAndMemberReads_RetainLexicalAccess()
    {
        const string source = """
            package Issue4341
            import Gsharp.Extensions.Go
            import System

            class InstanceWorker {
                private let value int32 = 1
                private func work() { Console.WriteLine(value) }
                func run() { scope { go work() } }
            }

            class SharedWorker[T] {
                shared {
                    private func work() { Console.WriteLine("shared") }
                    func run() { scope { go work() } }
                }
            }

            open class BaseWorker {
                protected func work() { Console.WriteLine("protected") }
            }

            class DerivedWorker : BaseWorker {
                func run() { scope { go work() } }
            }

            struct StructWorker {
                private func work() { Console.WriteLine("struct") }
                func run() { scope { go work() } }
            }

            class PropertyWorker {
                private prop Value int32 -> 5
                func run() { scope { go Console.WriteLine(Value) } }
            }

            class AsyncLetWorker {
                private func work() int32 -> 6
                func run() int32 {
                    scope {
                        async let value = work()
                        return await value
                    }
                }
            }

            InstanceWorker().run()
            SharedWorker[string].run()
            DerivedWorker().run()
            StructWorker{}.run()
            PropertyWorker().run()
            Console.WriteLine(AsyncLetWorker().run())
            """;

        var output = CompileVerifyAndRun(source);
        Assert.Equal(
            $"1{Environment.NewLine}shared{Environment.NewLine}protected{Environment.NewLine}struct{Environment.NewLine}5{Environment.NewLine}6{Environment.NewLine}",
            output);
    }

    private static string CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4341_").FullName;
        try
        {
            var sourcePath = Path.Combine(tempDir, "test.gs");
            var assemblyPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(
                [
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                ]);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
            IlVerifier.Verify(assemblyPath);

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath,
                },
                WorkingDirectory = tempDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });

            Assert.NotNull(process);
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{output}\nstderr:\n{error}");
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
