// <copyright file="Issue2732AsyncNullablePatternConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2732: converting a value-type nullable to its underlying type must
/// emit a real nullable unwrap after async hoisting, including top-level state
/// machines and protected regions.
/// </summary>
public sealed class Issue2732AsyncNullablePatternConversionEmitTests
{
    private const string ExactOahuCliFingerprint = "248fb4aeedcd";

    [Fact]
    public void ExactOahuCliFingerprint_TopLevelAsyncPatternInTry_RunsAndVerifies()
    {
        const string Source = """
            package Oahu.Cli
            import System
            import System.Threading.Tasks

            await Task.Yield()
            let rewriteResult int32? = 42
            try {
                let __spill0 = rewriteResult
                var code int32
                if __spill0 is int32 {
                    code = int32(__spill0)
                    Console.WriteLine(code)
                }
            } catch (ex Exception) {
                Console.WriteLine("failed")
            }
            """;

        Assert.Equal("42\n", CompileVerifyAndRun(Source, "Exact"));
    }

    [Fact]
    public void HoistedNullableParameter_ExplicitUnderlyingConversionInTry_RunsAndVerifies()
    {
        const string Source = """
            package Issue2732.Generalized
            import System
            import System.Threading.Tasks

            async func Unwrap(value int32?) int32 {
                await Task.Yield()
                try {
                    return int32(value)
                } catch (ex InvalidOperationException) {
                    return -1
                }
            }

            Console.WriteLine(Unwrap(17).Result)
            Console.WriteLine(Unwrap(nil).Result)
            """;

        Assert.Equal("17\n-1\n", CompileVerifyAndRun(Source, "Generalized"));
    }

    [Fact]
    public void NullableToUnderlyingConversion_RemainsExplicitOnly()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package Issue2732.Negative

            func Invalid(value int32?) int32 {
                var result int32 = value
                return result
            }
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2732.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0156");
    }

    private static string CompileVerifyAndRun(string source, string caseName)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2732AsyncNullablePatternConversionEmitTests),
            ExactOahuCliFingerprint,
            caseName);
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
            Assert.True(
                exitCode == 0,
                $"StackUnexpected fingerprint {ExactOahuCliFingerprint} must be clean.\n"
                + $"compile failed ({exitCode}):\n{stdout}\n{stderr}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath);

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
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, error);
        return output.Replace("\r\n", "\n");
    }
}
