// <copyright file="Issue2725ConstrainedNullAssertedReceiverEmitTests.cs" company="GSharp">
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
/// Issue #2725: constrained member access over a null-asserted generic receiver
/// must reserve the addressable receiver spill consumed by the emitter.
/// </summary>
public sealed class Issue2725ConstrainedNullAssertedReceiverEmitTests
{
    private const string ExactOahuCoreFingerprint = "2f128c1866ee";

    [Fact]
    public void ExactOahuCoreFingerprint_NullAssertedConstrainedCount_RunsAndVerifies()
    {
        const string Source = """
            package Oahu.Core
            import System
            import System.Collections.Generic

            func CountText[T ICollection[object]](p T?) string {
                return p!!.Count.ToString()
            }

            func MutateText[T IList[object]](p T?) string {
                p!!.Add("three")
                p!![0] = "zero"
                return p!!.Count.ToString() + ":" + p!![0].ToString()
            }

            var values = List[object]{ "one", "two" }
            Console.WriteLine(CountText[List[object]](values))
            Console.WriteLine(MutateText[List[object]](values))
            """;

        Assert.Equal("2\n3:zero\n", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void IncompatibleConstraintArgument_RemainsRejected()
    {
        var syntax = SyntaxTree.Parse(SourceText.From(
            """
            package Oahu.Core.Negative
            import System.Collections.Generic

            func CountText[T ICollection[object]](p T?) string {
                return p!!.Count.ToString()
            }

            let invalid = CountText[int32](1)
            """));
        var compilation = new Compilation(syntax);

        using var output = new MemoryStream();
        var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2725.Negative");

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0152");
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2725Emit", ExactOahuCoreFingerprint);
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
                $"Exact GS9998 fingerprint {ExactOahuCoreFingerprint} must fall from 1 to 0.\n"
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
