// <copyright file="Issue3254EnclosingGenericClosureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3254: synthesized lambda and <c>go</c> closure types must preserve
/// enclosing generic type parameters at their definitions and use sites.
/// </summary>
public class Issue3254EnclosingGenericClosureEmitTests
{
    [Fact]
    public void LambdaCapturingNestedTypeWithEnclosingTypeParameterRuns()
    {
        const string Source = """
            package Issue3254.Lambda
            import System

            class Thing {
            }

            class Owner[T] {
                struct Payload[U] {
                    var First T
                    var Second U
                }
            }

            func Run[T, U](value Owner[T].Payload[U]) {
                let read = () -> value
                Console.WriteLine([]T{ read().First }.GetType())
                Console.WriteLine(read().First)
                Console.WriteLine([]U{ read().Second }.GetType())
                Console.WriteLine(read().Second)
            }

            func ShowTypes[T, U](value Owner[T].Payload[U]) {
                let read = () -> value
                Console.WriteLine([]T{ read().First }.GetType())
                Console.WriteLine([]U{ read().Second }.GetType())
            }

            func Main() {
                Run[int32, string](Owner[int32].Payload[string]{ First: 42, Second: "right" })
                Run[string, int32](Owner[string].Payload[int32]{ First: "left", Second: 7 })
                ShowTypes[string, Thing](Owner[string].Payload[Thing]{ First: "ref", Second: Thing{} })
            }
            """;

        AssertCompilesAndRuns(
            Source,
            "System.Int32[]\n42\nSystem.String[]\nright\n"
                + "System.String[]\nleft\nSystem.Int32[]\n7\n"
                + "System.String[]\nIssue3254.Lambda.Thing[]\n",
            nameof(LambdaCapturingNestedTypeWithEnclosingTypeParameterRuns));
    }

    [Fact]
    public void LambdaCapturingUnqualifiedNestedTypeInsideGenericClassRuns()
    {
        const string Source = """
            package Issue3254.UnqualifiedLambda
            import System

            class Owner[T] {
                struct Payload[U] {
                    var First T
                    var Second U
                }

                func Show(value Payload[string]) {
                    let read = () -> value
                    Console.WriteLine([]T{ read().First }.GetType())
                    Console.WriteLine(read().First)
                }
            }

            func Main() {
                Owner[int32]{}.Show(Owner[int32].Payload[string]{ First: 42, Second: "int" })
                Owner[string]{}.Show(Owner[string].Payload[string]{ First: "right", Second: "string" })
            }
            """;

        AssertCompilesAndRuns(
            Source,
            "System.Int32[]\n42\nSystem.String[]\nright\n",
            nameof(LambdaCapturingUnqualifiedNestedTypeInsideGenericClassRuns));
    }

    [Fact]
    public void GoInsideGenericFunctionPreservesCapturedTypeParameter()
    {
        const string Source = """
            package Issue3254.Go
            import System
            import Gsharp.Extensions.Go

            func Show[T](value T) int32 {
                Console.WriteLine([]T{ value }.GetType())
                Console.WriteLine(value)
                return 0
            }

            func Run[T](value T) {
                scope {
                    go Show[T](value)
                }
            }

            class Runner[T] {
                func Run(value T) {
                    scope {
                        go Show[T](value)
                    }
                }
            }

            func Main() {
                Run[int32](42)
                Run[string]("right")
                Runner[int32]{}.Run(7)
                Runner[string]{}.Run("class")
            }
            """;

        AssertCompilesAndRuns(
            Source,
            "System.Int32[]\n42\nSystem.String[]\nright\n"
                + "System.Int32[]\n7\nSystem.String[]\nclass\n",
            nameof(GoInsideGenericFunctionPreservesCapturedTypeParameter));
    }

    [Fact]
    public void AsyncGoInsideGenericFunctionPreservesCapturedTypeParameter()
    {
        const string Source = """
            package Issue3254.AsyncGo
            import System
            import System.Threading.Tasks
            import Gsharp.Extensions.Go

            async func Show[T](value T) {
                await Task.Delay(1)
                Console.WriteLine([]T{ value }.GetType())
                Console.WriteLine(value)
            }

            func Run[T](value T) {
                scope {
                    go Show[T](value)
                }
            }

            func Main() {
                Run[int32](42)
                Run[string]("right")
            }
            """;

        AssertCompilesAndRuns(
            Source,
            "System.Int32[]\n42\nSystem.String[]\nright\n",
            nameof(AsyncGoInsideGenericFunctionPreservesCapturedTypeParameter));
    }

    private static void AssertCompilesAndRuns(string source, string expectedOutput, string testName)
    {
        var directory = Directory.CreateDirectory(
            Path.Combine(AppContext.BaseDirectory, "issue3254", testName + "-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "Probe.gs");
            var assemblyPath = Path.Combine(directory, "Probe.dll");
            File.WriteAllText(sourcePath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(
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
                Console.SetError(previousError);
            }

            Assert.True(
                compileExit == 0,
                $"gsc exited {compileExit}\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }) ?? throw new InvalidOperationException("Failed to start dotnet exec.");

            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
            var stderr = stderrTask.GetAwaiter().GetResult();
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            Assert.Equal(expectedOutput, stdout);

            IlVerifier.Verify(assemblyPath);
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
