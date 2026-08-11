// <copyright file="Issue3084TupleAsyncFunctionMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3084TupleAsyncFunctionMemberTests
{
    [Fact]
    public void TupleAsyncFunctionItem4_BindsVerifiesAndRuns()
    {
        const string source = """
            package Issue3084

            import System
            import System.Linq
            import System.Threading.Tasks

            class Payload(Value string) { }

            async func RunAsync() string {
                let handler async (Payload) -> string = async (value Payload) -> {
                    await Task.Yield()
                    return value.Value
                }
                let state object = 42
                let tuples = [](string, string, object, async (Payload) -> string){
                    ("first", "second", state, handler)
                }
                let tuple = tuples!!.FirstOrDefault((candidate (string, string, object, async (Payload) -> string)) -> candidate.Item1 == "first")
                Console.WriteLine(tuple.Item1)
                return await tuple.Item4(Payload("result"))
            }

            Console.WriteLine(RunAsync().GetAwaiter().GetResult())
            """;

        Assert.Equal($"first{Environment.NewLine}result{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3084TupleAsyncFunctionMemberTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue3084.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
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
                Console.SetError(previousError);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:{Environment.NewLine}{standardOut}{standardError}");
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
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
