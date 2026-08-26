// <copyright file="Issue3501LookupIndexerElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501: an indexer whose result merely MENTIONS the receiver's type
/// parameter inside a constructed generic — `ILookup[TKey, TElement].this[TKey]`
/// returning `IEnumerable[TElement]` — fell through the bare-slot substitution
/// and used the erased closed shape, so a lookup over a same-compilation
/// element type surfaced `IEnumerable[object]` and every member read on the
/// iterated element failed GS0158 (the `byStatus[status]` shape in the
/// migrated ConstructInventory).
/// </summary>
public class Issue3501LookupIndexerElementTests
{
    [Fact]
    public void LookupIndexer_PreservesSourceElementType()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic
            import System.Linq

            class Row {
                var Name string
                var Rank int32
            }

            func rows() List[Row] {
                let all = List[Row]()
                all.Add(Row{ Name: "a", Rank: 1 })
                all.Add(Row{ Name: "b", Rank: 2 })
                all.Add(Row{ Name: "c", Rank: 1 })
                return all
            }

            let byRank = rows().ToLookup((r Row) -> r.Rank)
            var acc = ""
            for entry in byRank[1] {
                acc = acc + entry.Name
            }
            for entry in byRank[2].ToList() {
                acc = acc + entry.Name
            }
            Console.WriteLine(acc)
            """);

        Assert.Equal("acb" + Environment.NewLine, output);
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3501_lookup_").FullName;
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
