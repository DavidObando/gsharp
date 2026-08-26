// <copyright file="Issue3551DeferredLambdaReifiedReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3551: deferred arrow-lambda parameter inference used the receiver's
/// CACHED (possibly erased) <c>ClrType</c>. A symbolic receiver such as
/// <c>IGrouping[string?, (string, int32?)]</c> (a nullable-annotated key from
/// a <c>GroupBy</c> whose selector returns <c>string?</c>) can cache a closed
/// shape whose tuple argument lost its <c>Nullable</c> element
/// (<c>ValueTuple&lt;string, int&gt;</c>), so the lambda was rebound against the
/// wrong tuple and every extension call on the grouping failed GS0159
/// ("Cannot find function Select"). The inference paths now prefer
/// <c>ReifyClosedClrType()</c>, matching the extension-dispatch path.
/// </summary>
public class Issue3551DeferredLambdaReifiedReceiverTests
{
    [Fact]
    public void NullableKeyGrouping_TupleElementLambdas_Resolve()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic
            import System.Linq

            let two int32? = 2
            let none int32? = nil
            let xs = List[(string, int32, int32?)]()
            xs.Add(("a", 1, two))
            xs.Add(("b", 2, none))
            xs.Add(("c", 3, two))

            let keys = List[string]()
            keys.Add("k0")
            keys.Add("k1")
            keys.Add("k2")

            var n = 0
            var names = ""
            for group in xs.GroupBy((t (string, int32, int32?)) -> if (t.Item3 != nil) { keys[t.Item3!!] } else { default(string?) }) {
                let members = group.Select((t (string, int32, int32?)) -> t.Item1).ToList()
                n = n + members.Count
                for name in members.OrderBy((s string) -> s) {
                    names = names + name
                }
            }
            Console.WriteLine(n)
            Console.WriteLine(names)
            """);

        Assert.Equal(
            string.Join(Environment.NewLine, "3", "acb") + Environment.NewLine,
            output);
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3551_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            int exitCode = RunCompiler(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            }, out string diagnostics);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath);
            return RunAssembly(directory, outputPath);
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

    private static int RunCompiler(string[] arguments, out string diagnostics)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            int exitCode = Program.Main(arguments);
            diagnostics = $"stdout:\n{stdout}\nstderr:\n{stderr}";
            return exitCode;
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string RunAssembly(string workingDirectory, string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exec exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }
}
