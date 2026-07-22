// <copyright file="Issue2751GenericAsyncResultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2751: generic async calls must expose one Task wrapper at both open
/// and closed call sites.
/// </summary>
public sealed class Issue2751GenericAsyncResultEmitTests
{
    [Fact]
    public void OverloadedOpenAndClosedGenericAsyncCalls_VerifyAndRun()
    {
        _ = typeof(System.Text.Json.JsonSerializer).Assembly;
        const string source = """
            package Issue2751Exact

            import System
            import System.Threading.Tasks
            import System.Text.Json

            async func Read[T](json string) T {
                await Task.Yield()
                return JsonSerializer.Deserialize[T](json)
            }

            async func Read[T](prefix string, json string) T {
                let text = prefix + json
                return await Read[T](text)
            }

            async func Closed() int32 {
                let json = "4" + "2"
                return await Read[int32]("", json)
            }

            Console.WriteLine(Closed().GetAwaiter().GetResult())
            """;

        Assert.Equal("42\n", CompileVerifyAndRun(source, "exact"));
    }

    [Fact]
    public void OpenGenericAsyncCall_VerifiesAndRuns()
    {
        const string source = """
            package Issue2751Open

            import System
            import System.Threading.Tasks

            async func Read[T](value T) T {
                await Task.Yield()
                return value
            }

            async func Forward[T](value T) T {
                return await Read[T](value)
            }

            Console.WriteLine(Forward[string]("open").GetAwaiter().GetResult())
            """;

        Assert.Equal("open\n", CompileVerifyAndRun(source, "open"));
    }

    [Fact]
    public void ClosedGenericAsyncCall_VerifiesAndRuns()
    {
        const string source = """
            package Issue2751Closed

            import System
            import System.Threading.Tasks

            async func Read[T](value T) T {
                await Task.Yield()
                return value
            }

            async func Run() int32 {
                return await Read[int32](42)
            }

            Console.WriteLine(Run().GetAwaiter().GetResult())
            """;

        Assert.Equal("42\n", CompileVerifyAndRun(source, "closed"));
    }

    [Fact]
    public void NonGenericImportedNestedTaskAndTupleControls_VerifyAndRun()
    {
        const string source = """
            package Issue2751Controls

            import System
            import System.Threading.Tasks

            async func NonGeneric() int32 {
                return 1
            }

            async func Nested[T](value T) Task[Task[T]] {
                await Task.Yield()
                return Task.FromResult[T](value)
            }

            async func Pair[T](value T) (T, T) {
                await Task.Yield()
                return (value, value)
            }

            async func PairFirst[T](value T) T {
                let (first, second) = await Pair[T](value)
                return first
            }

            async func Controls() int32 {
                let imported = await Task.FromResult[int32](2)
                let inner = await Nested[int32](3)
                let nested = await inner
                let tuple = await PairFirst[int32](4)
                let plain = await NonGeneric()
                return imported + nested + tuple + plain
            }

            Console.WriteLine(Controls().GetAwaiter().GetResult())
            """;

        Assert.Equal("10\n", CompileVerifyAndRun(source, "controls"));
    }

    private static string CompileVerifyAndRun(string source, string name)
    {
        var (directory, outputPath) = CompileAndVerify(source, name);

        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                outputPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
        var output = process!.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, error);
        return output.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static (string Directory, string OutputPath) CompileAndVerify(string source, string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2751Emit", name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):{Environment.NewLine}{stdout}{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath);
        return (directory, outputPath);
    }
}
