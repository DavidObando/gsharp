// <copyright file="Issue3560TupleGenericArgumentConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3560TupleGenericArgumentConversionTests
{
    [Fact]
    public void ListAdd_TupleLiteralNullableLift_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3560

            import System
            import System.Collections.Generic

            func Add(values List[(string, int32, int32?)]) {
                values.Add(("a", 1, 2))
            }

            let values = List[(string, int32, int32?)]()
            Add(values)

            Console.WriteLine(values[0].Item3)
            """;

        Assert.Equal($"2{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void ListAdd_TupleLiteralNil_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3560

            import System
            import System.Collections.Generic

            func Add(values List[(string, int32, int32?)]) {
                values.Add(("b", 2, nil))
            }

            let values = List[(string, int32, int32?)]()
            Add(values)

            Console.WriteLine(values[0].Item3 == nil)
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void ListAdd_NamedTupleLiteralNullableLift_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3560

            import System
            import System.Collections.Generic

            let values = List[(string, int32, int32?)]()
            values.Add(item: ("a", 1, 2))

            Console.WriteLine(values[0].Item3)
            """;

        Assert.Equal($"2{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void ListAdd_NamedTupleLiteralNil_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3560

            import System
            import System.Collections.Generic

            let values = List[(string, int32, int32?)]()
            values.Add(item: ("b", 2, nil))

            Console.WriteLine(values[0].Item3 == nil)
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3560TupleGenericArgumentConversionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue3560.dll");
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

            Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{standardOut}{standardError}");
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
