// <copyright file="Issue2957FunctionLiteralIteratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2957: iterator function literals must receive iterator state-machine
/// plans before their hosted bodies reach emission.
/// </summary>
public sealed class Issue2957FunctionLiteralIteratorTests
{
    public static IEnumerable<object[]> Cases()
    {
        yield return Case(
            "ExactRepro",
            """
            package Repro
            import System

            let values = func() sequence[int32] { yield 2 }
            for value in values() {
                Console.WriteLine(value)
            }
            """,
            "2\n");

        yield return Case(
            "NestedLiteral",
            """
            package Nested
            import System

            let outer = func() () -> sequence[int32] {
                return func() sequence[int32] { yield 3 }
            }

            for value in outer()() {
                Console.WriteLine(value)
            }
            """,
            "3\n");

        yield return Case(
            "CapturedLocalAcrossYield",
            """
            package Capture
            import System

            func make(start int32) () -> sequence[int32] {
                return func() sequence[int32] {
                    yield start
                    Console.WriteLine(start)
                    yield start + 1
                }
            }

            for value in make(4)() {
                Console.WriteLine(value)
            }
            """,
            "4\n4\n5\n");

        yield return Case(
            "GenericStateMachineSignatureRemap",
            """
            package Generic
            import System

            func make[T any]() (T) -> sequence[T] {
                return func(value T) sequence[T] { yield value }
            }

            for value in make[string]()("ok") {
                Console.WriteLine(value)
            }
            """,
            "ok\n");

        yield return Case(
            "LoweredForInEnumerator",
            """
            package ForIn
            import System

            let values = func() sequence[int32] {
                for value in []int32{4, 5} {
                    yield value
                }
            }

            for value in values() {
                Console.WriteLine(value)
            }
            """,
            "4\n5\n");

        yield return Case(
            "LoweredForInEnumeratorWithCapture",
            """
            package ForInCapture
            import System

            func make(offset int32) () -> sequence[int32] {
                return func() sequence[int32] {
                    for value in []int32{4, 5} {
                        yield offset + value
                    }
                }
            }

            for value in make(100)() {
                Console.WriteLine(value)
            }
            """,
            "104\n105\n");

        yield return Case(
            "LoweredForEllipsisCounter",
            """
            package ForEllipsis
            import System

            let values = func() sequence[int32] {
                for value in 0 ... 2 {
                    yield value
                }
            }

            for value in values() {
                Console.WriteLine(value)
            }
            """,
            "0\n1\n");

        yield return Case(
            "GenericStateMachineElementTokenRemap",
            """
            package GenericToken
            import System

            func make[T any]() (T) -> sequence[T] {
                return func(value T) sequence[T] {
                    let copy = []T{value}
                    yield copy[0]
                }
            }

            for value in make[int32]()(42) {
                Console.WriteLine(value)
            }
            """,
            "42\n");

        yield return Case(
            "ImmediatelyInvoked",
            """
            package Immediate
            import System

            for value in (func() sequence[int32] { yield 7 })() {
                Console.WriteLine(value)
            }
            """,
            "7\n");

        yield return Case(
            "NamedFunctionGuard",
            """
            package Named
            import System

            func values() sequence[int32] { yield 9 }
            for value in values() {
                Console.WriteLine(value)
            }
            """,
            "9\n");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void IteratorLiteral_LoadsAndRuns(string name, string source, string expectedOutput)
    {
        var assemblyPath = Compile(name, source);
        IlVerifier.Verify(assemblyPath);
        Assert.NotEmpty(Assembly.Load(File.ReadAllBytes(assemblyPath)).GetTypes());
        Assert.Equal(expectedOutput, RunBounded(name, assemblyPath));
    }

    private static object[] Case(string name, string source, string expectedOutput)
        => new object[] { name, source, expectedOutput };

    private static string Compile(string name, string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2957FunctionLiteralIteratorTests),
            name);
        Directory.CreateDirectory(directory);

        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(exitCode == 0, $"{name}: gsc failed:\n{stdout}\n{stderr}");
        return assemblyPath;
    }

    private static string RunBounded(string name, string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(5_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            Assert.True(process.WaitForExit(5_000), $"{name}: child did not stop after kill");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult().Replace("\r\n", "\n", StringComparison.Ordinal);
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(exited, $"{name}: emitted program timed out");
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{stderr}");
        return stdout;
    }
}
