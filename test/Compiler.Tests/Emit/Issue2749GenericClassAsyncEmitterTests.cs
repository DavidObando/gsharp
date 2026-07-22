// <copyright file="Issue2749GenericClassAsyncEmitterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2749: async state-machine field references must use the canonical
/// generic identity of the state machine and its hoisted receiver.
/// </summary>
public class Issue2749GenericClassAsyncEmitterTests
{
    public static IEnumerable<object[]> AsyncGenericMatrix()
    {
        yield return Case(
            "non-generic class",
            """
            class Job2749 {
                async func Run(value string) string {
                    let hoisted = value
                    await Task.Delay(1)
                    return hoisted
                }
            }
            Console.WriteLine(Job2749().Run("plain").Result)
            """,
            "plain\n");
        yield return Case(
            "generic class",
            """
            class Job2749[T](Seed T) {
                async func Run(value T) T {
                    let hoisted = value
                    await Task.Delay(1)
                    Console.WriteLine(Seed)
                    return hoisted
                }
            }
            Console.WriteLine(Job2749[string]("class").Run("hoisted").Result)
            """,
            "class\nhoisted\n");
        yield return Case(
            "generic method",
            """
            async func Run2749[T](value T) T {
                let hoisted = value
                await Task.Delay(1)
                return hoisted
            }
            Console.WriteLine(Run2749("method").Result)
            """,
            "method\n");
        yield return Case(
            "generic class and method",
            """
            class Job2749[T](Seed T) {
                async func Run[U](value U) T {
                    let hoistedT = Seed
                    let hoistedU = value
                    await Task.Delay(1)
                    Console.WriteLine(hoistedU)
                    return hoistedT
                }
            }
            Console.WriteLine(Job2749[string]("class-method").Run(42).Result)
            """,
            "42\nclass-method\n");
        yield return Case(
            "generic class with async captures",
            """
            class Job2749[T](Seed T, Callback (T) -> void) {
                private let Values List[T] = List[T]()

                async func Run(value T) T {
                    let hoisted = value
                    let action = () -> Callback(hoisted)
                    await Task.Delay(1)
                    action()
                    Values.Add(hoisted)
                    return Seed
                }
            }
            let job = Job2749[string]("captured", (value string) -> Console.WriteLine(value))
            Console.WriteLine(job.Run("callback").Result)
            """,
            "callback\ncaptured\n");
        yield return Case(
            "nested generic class",
            """
            class Outer2749[T](Seed T) {
                class Job2749(Seed T) {
                    async func Run(value T) T {
                        let hoisted = value
                        let action = () -> Console.WriteLine(hoisted)
                        await Task.Delay(1)
                        action()
                        return Seed
                    }
                }

                func Run(value T) T {
                    return Job2749(Seed).Run(value).Result
                }
            }
            Console.WriteLine(Outer2749[string]("nested").Run("captured-nested"))
            """,
            "captured-nested\nnested\n");
    }

    [Theory]
    [MemberData(nameof(AsyncGenericMatrix))]
    public void AwaitAndHoistedLocals_VerifyAndRun(string _, string source, string expected)
    {
        Assert.Equal(expected, CompileVerifyAndRun(source));
    }

    private static object[] Case(string name, string body, string expected) =>
        new object[]
        {
            name,
            """
            package issue2749
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            """ + body,
            expected,
        };

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            Directory.GetCurrentDirectory(),
            "out",
            "test-artifacts",
            "issue2749-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(exitCode == 0, $"gsc failed:\n{compileOut}\n{compileErr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo);
            var stdout = process!.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
