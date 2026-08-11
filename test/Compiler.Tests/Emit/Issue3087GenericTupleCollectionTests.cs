// <copyright file="Issue3087GenericTupleCollectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3087GenericTupleCollectionTests
{
    [Fact]
    public void FourElementTuple_ListAndDictionaryWhere_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3087

            import System
            import System.Collections.Generic
            import System.Linq

            let values = List[(int32, int32, float64, TimeSpan)]()
            values.Add((1, 2, 0.5, TimeSpan.Zero))
            values.Add((3, 4, 1.5, TimeSpan.FromSeconds(2)))

            let filtered = values.Where((value) -> value.Item3 > 1.0).ToList()
            if filtered.Count != 1 { Environment.Exit(11) }
            let item = filtered[0]
            if item.Item1 != 3 { Environment.Exit(12) }
            if item.Item2 != 4 { Environment.Exit(13) }
            if item.Item3 != 1.5 { Environment.Exit(14) }
            if item.Item4 != TimeSpan.FromSeconds(2) { Environment.Exit(15) }

            let dictionary = Dictionary[string, (int32, int32, float64, TimeSpan)]()
            dictionary.Add("low", (1, 2, 0.5, TimeSpan.Zero))
            dictionary.Add("high", (3, 4, 1.5, TimeSpan.FromSeconds(2)))

            let filteredValues = dictionary.Values.Where((value) -> value.Item3 > 1.0).ToList()
            if filteredValues.Count != 1 { Environment.Exit(21) }
            let dictionaryItem = filteredValues[0]
            if dictionaryItem.Item1 != 3 { Environment.Exit(22) }
            if dictionaryItem.Item2 != 4 { Environment.Exit(23) }
            if dictionaryItem.Item3 != 1.5 { Environment.Exit(24) }
            if dictionaryItem.Item4 != TimeSpan.FromSeconds(2) { Environment.Exit(25) }

            Console.WriteLine("ok")
            """;

        Assert.Equal($"ok{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void SymbolicTupleCollections_AllClrTupleNodes_CompileVerifyAndRun()
    {
        Assert.Equal($"ok{Environment.NewLine}", CompileVerifyAndRun(BuildSymbolicTupleMatrixSource()));
    }

    private static string BuildSymbolicTupleMatrixSource()
    {
        var source = new StringBuilder("""
            package Issue3087Symbolic

            import System
            import System.Collections.Generic
            import System.Linq

            class Box(Value int32) { }

            """);

        for (var arity = 2; arity <= 16; arity++)
        {
            var types = new string[arity];
            var values = new string[arity];
            types[0] = "Box";
            values[0] = $"Box({arity})";
            for (var index = 1; index < arity - 1; index++)
            {
                types[index] = "int32";
                values[index] = (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            }

            types[^1] = "TimeSpan";
            values[^1] = $"TimeSpan.FromSeconds({arity})";
            var tupleType = "(" + string.Join(", ", types) + ")";
            var tupleValue = "(" + string.Join(", ", values) + ")";

            source.AppendLine($"let list{arity} List[{tupleType}] = List[{tupleType}]()");
            source.AppendLine($"list{arity}.Add({tupleValue})");
            source.AppendLine($"let filtered{arity} = list{arity}.Where((value) -> value.Item1.Value > 0).ToList()");
            source.AppendLine($"if filtered{arity}.Count != 1 {{ Environment.Exit({100 + arity}) }}");
            source.AppendLine($"if filtered{arity}[0].Item1.Value != {arity} {{ Environment.Exit({120 + arity}) }}");
            source.AppendLine($"if filtered{arity}[0].Item{arity} != TimeSpan.FromSeconds({arity}) {{ Environment.Exit({140 + arity}) }}");
            source.AppendLine($"let dictionary{arity} = Dictionary[string, {tupleType}]()");
            source.AppendLine($"dictionary{arity}.Add(\"value\", {tupleValue})");
            source.AppendLine($"let values{arity} = dictionary{arity}.Values.Where((value) -> value.Item1.Value > 0).ToList()");
            source.AppendLine($"if values{arity}.Count != 1 {{ Environment.Exit({160 + arity}) }}");
            source.AppendLine($"if values{arity}[0].Item{arity} != TimeSpan.FromSeconds({arity}) {{ Environment.Exit({180 + arity}) }}");
            source.AppendLine();
        }

        source.AppendLine("""
            let queue = Queue[(Box, int32, int32, int32, int32, int32, int32, TimeSpan)]()
            queue.Enqueue((Box(8), 2, 3, 4, 5, 6, 7, TimeSpan.FromSeconds(8)))
            if queue.Dequeue().Item8 != TimeSpan.FromSeconds(8) { Environment.Exit(208) }

            let patternTuple = (Box(8), 2, 3, 4, 5, 6, 7, 8)
            let patternResult = switch patternTuple { case { Item8: 8 }: "hit" default: "miss" }
            if patternResult != "hit" { Environment.Exit(209) }

            Console.WriteLine("ok")
            """);
        return source.ToString();
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3087GenericTupleCollectionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue3087.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            foreach (var reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths())
            {
                arguments.Add("/r:" + reference);
            }

            arguments.Add(sourcePath);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(arguments.ToArray());
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
