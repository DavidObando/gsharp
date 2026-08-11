// <copyright file="Issue2947ImportedNestedGenericDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2947: Emitted-execution coverage for imported nested generic.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2947ImportedNestedGenericDriverTests
{
    private const string LibrarySource = """
        package glib

        public struct Outer[T] {
            public enum Color { Red = 4, Green = 5, Blue = 6 }
            public struct Value { public var N int32 }
            public class Ref { public var N int32 }

            public struct Mid {
                public enum Tone { Red = 7, Green = 8, Blue = 9 }
                public struct Value { public var N int32 }
                public class Ref { public var N int32 }
            }
        }
        """;

    private const string ReportedSource = """
        package z2947b
        struct Holder[T] {
            public func Take() int32 {
                var c glib.Outer[T].Color = glib.Outer[T].Color.Green
                return int32(c)
            }
        }

        17
        """;

    private const string ExecutedReportedSource = """
        package z2947b
        import System

        struct Holder[T] {
            public func Take() int32 {
                var c glib.Outer[T].Color = glib.Outer[T].Color.Green
                return int32(c)
            }
        }

        Console.WriteLine(Holder[string]{}.Take())
        """;

    private const string DiagnosticSource = """
        package z2947b

        struct Holder[T] {
            public func Take() int32 {
                var exact glib.Outer[T].Color = glib.Outer[T].Color.Green
                var maybe glib.Outer[T].Color? = exact
                var c glib.Outer[T].Color = maybe
                var i int32 = exact
                return i
            }
        }

        Holder[string]{}.Take()
        """;

    private static readonly string[] ExpectedDiagnostics =
    {
        "Cannot convert type 'glib.Outer[T].Color?' to 'glib.Outer[T].Color'. An explicit conversion exists (are you missing a cast?)",
        "Cannot convert type 'glib.Outer[T].Color' to 'int32'. An explicit conversion exists (are you missing a cast?)",
    };

    [Fact]
    public void ImportedNestedTypes_PreserveArgumentsAcrossMatrixAndAllDrivers()
    {
        var directory = CreateEmptyTestDirectory();
        try
        {
            var libraryPath = Path.Combine(directory, "glib.dll");
            var librarySourcePath = WriteSource(directory, "lib.gs", LibrarySource);
            var library = RunCompiler(
                "/target:library",
                "/out:" + libraryPath,
                librarySourcePath);
            AssertSucceeded(library, "library");

            var reportedPath = WriteSource(directory, "reported.gs", ReportedSource);
            var bare = RunCompiler("/nowarn:GS9100", "/r:" + libraryPath, reportedPath);
            AssertSucceeded(bare, "reported bare gsc");
            Assert.Equal($"Success.{Environment.NewLine}", Normalize(bare.StandardOutput));
            Assert.Equal(string.Empty, bare.StandardError);

            var executedReportedPath = WriteSource(directory, "reported-executed.gs", ExecutedReportedSource);
            var reportedAssemblyPath = Path.Combine(directory, "reported.dll");
            var emitted = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + reportedAssemblyPath,
                "/r:" + libraryPath,
                executedReportedPath);
            AssertSucceeded(emitted, "reported emit");
            Assert.Equal($"5{Environment.NewLine}", RunAssembly(directory, reportedAssemblyPath));

            _ = Assembly.LoadFrom(libraryPath);
            var gsi = RunGsi(executedReportedPath);
            AssertSucceeded(gsi, "reported gsi");
            Assert.Equal($"5{Environment.NewLine}", Normalize(gsi.StandardOutput));
            Assert.Equal(string.Empty, gsi.StandardError);

            var diagnosticPath = WriteSource(directory, "diagnostic.gs", DiagnosticSource);
            var bareDiagnostics = RunCompiler("/nowarn:GS9100", "/r:" + libraryPath, diagnosticPath);
            var emitDiagnostics = RunCompiler(
                "/target:exe",
                "/nowarn:GS9100",
                "/out:" + Path.Combine(directory, "diagnostic.dll"),
                "/r:" + libraryPath,
                diagnosticPath);
            var gsiDiagnostics = RunGsi(diagnosticPath);

            Assert.Equal(1, bareDiagnostics.ExitCode);
            Assert.Equal(1, emitDiagnostics.ExitCode);
            Assert.Equal(1, gsiDiagnostics.ExitCode);
            Assert.Equal(ExpectedDiagnostics, ExtractDiagnosticMessages(bareDiagnostics.Combined));
            Assert.Equal(ExpectedDiagnostics, ExtractDiagnosticMessages(emitDiagnostics.Combined));
            Assert.Equal(ExpectedDiagnostics, ExtractDiagnosticMessages(gsiDiagnostics.Combined));
            Assert.DoesNotContain("object", bareDiagnostics.Combined, StringComparison.Ordinal);
            Assert.DoesNotContain("object", emitDiagnostics.Combined, StringComparison.Ordinal);
            Assert.DoesNotContain("object", gsiDiagnostics.Combined, StringComparison.Ordinal);

            var fullMatrix = CreateMatrixSource(includeReportedCells: true);
            Assert.Equal(36, fullMatrix.SiteCount);
            CompileAndRunMatrix(directory, libraryPath, "matrix-full", fullMatrix);

            var falsePositiveMatrix = CreateMatrixSource(includeReportedCells: false);
            Assert.Equal(34, falsePositiveMatrix.SiteCount);
            CompileAndRunMatrix(directory, libraryPath, "matrix-controls", falsePositiveMatrix);
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

    private static MatrixSource CreateMatrixSource(bool includeReportedCells)
    {
        var source = new StringBuilder(
            """
            package matrix2947
            import System
            import System.Collections.Generic

            public struct LocalOuter[T] {
                public enum Color { Red = 1, Green = 2 }
                public struct Value { public var N int32 }
                public class Ref { public var N int32 }

                public struct Mid {
                    public enum Tone { Red = 3, Green = 4 }
                    public struct Value { public var N int32 }
                    public class Ref { public var N int32 }
                }
            }

            struct Holder[T] {
                func Check() int32 {
                    var total int32 = 0
            """);

        var siteCount = 0;
        var expected = 0;
        foreach (var imported in new[] { true, false })
        {
            var outer = imported ? "glib.Outer" : "LocalOuter";
            foreach (var argument in new[] { "T", "int32", "List[int32]" })
            {
                foreach (var depth in new[] { string.Empty, ".Mid" })
                {
                    foreach (var kind in new[] { "enum", "struct", "class" })
                    {
                        if (!includeReportedCells
                            && imported
                            && argument == "T"
                            && kind == "enum")
                        {
                            continue;
                        }

                        siteCount++;
                        var suffix = kind switch
                        {
                            "enum" => depth.Length == 0 ? "Color" : "Tone",
                            "struct" => "Value",
                            _ => "Ref",
                        };
                        var type = $"{outer}[{argument}]{depth}.{suffix}";
                        var expression = kind == "enum" ? type + ".Green" : $"default({type})";
                        source.AppendLine($"        var value{siteCount} {type} = {expression}");
                        switch (kind)
                        {
                            case "enum":
                                source.AppendLine($"        total += int32(value{siteCount})");
                                expected += depth.Length == 0
                                    ? imported ? 5 : 2
                                    : imported ? 8 : 4;
                                break;
                            case "struct":
                                source.AppendLine($"        total += value{siteCount}.N");
                                break;
                            default:
                                source.AppendLine($"        if value{siteCount} == nil {{ total += 1 }}");
                                expected++;
                                break;
                        }
                    }
                }
            }
        }

        source.AppendLine("        return total");
        source.AppendLine("    }");
        source.AppendLine("}");
        source.AppendLine("Console.WriteLine(Holder[string]{}.Check())");
        return new MatrixSource(source.ToString(), siteCount, expected);
    }

    private static void CompileAndRunMatrix(
        string directory,
        string libraryPath,
        string name,
        MatrixSource matrix)
    {
        var sourcePath = WriteSource(directory, name + ".gs", matrix.Source);
        var assemblyPath = Path.Combine(directory, name + ".dll");
        var compilation = RunCompiler(
            "/target:exe",
            "/nowarn:GS9100",
            "/out:" + assemblyPath,
            "/r:" + libraryPath,
            sourcePath);
        AssertSucceeded(compilation, name);
        Assert.Equal(matrix.ExpectedValue + Environment.NewLine, RunAssembly(directory, assemblyPath));
    }

    private static DriverResult RunCompiler(params string[] arguments)
        => Capture(() => GSharp.Compiler.Program.Main(arguments));

    private static DriverResult RunGsi(string sourcePath)
        => Capture(() => GSharp.Repl.Program.Main(new[] { sourcePath }));

    private static DriverResult Capture(Func<int> action)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            return new DriverResult(action(), stdout.ToString(), stderr.ToString());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string RunAssembly(string directory, string assemblyPath)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        File.WriteAllText(
            runtimeConfigPath,
            """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var result = DotnetProcess.Run(
            directory,
            "exec",
            "--runtimeconfig",
            runtimeConfigPath,
            assemblyPath);
        Assert.True(
            result.ExitCode == 0,
            $"Emitted assembly exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
        return Normalize(result.StandardOutput);
    }

    private static string[] ExtractDiagnosticMessages(string output)
        => Regex.Matches(output, @"error GS0156: (?<message>[^\r\n]+)")
            .Select(match => match.Groups["message"].Value)
            .ToArray();

    private static void AssertSucceeded(DriverResult result, string operation)
        => Assert.True(
            result.ExitCode == 0,
            $"{operation} exited {result.ExitCode}\nstdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");

    private static string WriteSource(string directory, string fileName, string source)
    {
        var path = Path.Combine(directory, fileName);
        File.WriteAllText(path, source);
        return path;
    }

    private static string CreateEmptyTestDirectory()
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, $"{nameof(Issue2947ImportedNestedGenericDriverTests)}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        Assert.Empty(Directory.GetFileSystemEntries(path));
        return path;
    }

    private static string Normalize(string value)
        => value.ReplaceLineEndings(Environment.NewLine);

    private sealed record DriverResult(int ExitCode, string StandardOutput, string StandardError)
    {
        public string Combined => StandardOutput + StandardError;
    }

    private sealed record MatrixSource(string Source, int SiteCount, int ExpectedValue);
}
