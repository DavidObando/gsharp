// <copyright file="Issue3792DelegateCombinationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>Issue #3792: delegate combination lowers through Delegate.Combine/Remove.</summary>
public class Issue3792DelegateCombinationTests
{
    /// <summary>Gets executable delegate-combination cases.</summary>
    public static IEnumerable<object[]> Cases()
    {
        yield return new object[]
        {
            "imported-local-and-expression",
            """
            package P
            import System

            func First() { Console.WriteLine("first") }
            func Second() { Console.WriteLine("second") }

            let first Action = First
            let second Action = Second
            let pair = first + second
            pair()
            let removed = pair - first
            removed?()

            let leftNil = nil + first
            leftNil()
            let rightNil = first + nil
            rightNil()

            var callbacks Action? = nil
            callbacks += nil
            callbacks += first
            callbacks += second
            callbacks -= nil
            callbacks -= first
            callbacks?()
            callbacks -= second
            Console.WriteLine(callbacks == nil)
            """,
            new[] { "first", "second", "second", "first", "first", "second", "True" },
        };

        yield return new object[]
        {
            "structural-local",
            """
            package P
            import System

            let first (() -> void) = () -> Console.WriteLine("structural-first")
            let second (() -> void) = () -> Console.WriteLine("structural-second")
            var callbacks (() -> void)? = nil
            callbacks = callbacks + first
            callbacks += second
            callbacks?()
            callbacks -= first
            callbacks?()
            callbacks = callbacks - second
            Console.WriteLine(callbacks == nil)
            """,
            new[] { "structural-first", "structural-second", "structural-second", "True" },
        };

        yield return new object[]
        {
            "named-field-and-property",
            """
            package P
            import System

            delegate Handler(value string);

            func First(value string) { Console.WriteLine("first:" + value) }
            func Second(value string) { Console.WriteLine("second:" + value) }

            class Box {
                var Field Handler? = nil
                prop Property Handler? { get; set; }

                func Add(value Handler) {
                    Field += value
                    Property += value
                }

                func Remove(value Handler) {
                    Field -= value
                    Property -= value
                }
            }

            let first Handler = First
            let second Handler = Second
            let box = Box()
            box.Add(first)
            box.Add(second)
            box.Field?("field")
            box.Property?("property")
            box.Remove(first)
            box.Field?("field-removed")
            box.Property?("property-removed")
            """,
            new[]
            {
                "first:field",
                "second:field",
                "first:property",
                "second:property",
                "second:field-removed",
                "second:property-removed",
            },
        };

        yield return new object[]
        {
            "source-and-clr-method-groups",
            """
            package P
            import System

            func Print(value string) { Console.WriteLine("source:" + value) }
            func Print(value int32) { Console.WriteLine(value) }

            let seed Action[string] = (value string) -> Console.WriteLine("seed:" + value)
            let source = seed + Print
            let clr = source + Console.WriteLine
            clr("value")
            var callbacks Action[string]? = seed
            callbacks += Print
            callbacks += Console.WriteLine
            callbacks -= Print
            callbacks?("compound")
            """,
            new[]
            {
                "seed:value",
                "source:value",
                "value",
                "seed:compound",
                "compound",
            },
        };
    }

    /// <summary>Compiles, IL-verifies, executes, and checks each case.</summary>
    [Theory]
    [MemberData(nameof(Cases))]
    public void DelegateCombination_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3792_").FullName;
        try
        {
            var sourcePath = Path.Combine(tempDir, "Program.gs");
            var outputPath = Path.Combine(tempDir, name + ".dll");
            File.WriteAllText(sourcePath, source);

            var args = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(sourcePath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed for '{name}':\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outputPath);

            var (exitCode, output) = RunDotnet(outputPath);
            Assert.True(exitCode == 0, $"'{name}' exited {exitCode}:\n{output}");
            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int ExitCode, string Output) RunDotnet(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(tpa)
            ? Enumerable.Empty<string>()
            : tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
