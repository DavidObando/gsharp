// <copyright file="Issue2947ImportedNestedEnumSymbolicTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2947: imported nested enums preserve symbolic enclosing arguments.
/// </summary>
[Collection("ConsoleIo")]
public sealed class Issue2947ImportedNestedEnumSymbolicTests
{
    private const string ExpectedOutput = "22\n33\n11\n22\n33\n11\n";

    public static TheoryData<bool, string> DriverMatrix => new()
    {
        { false, "gsc-evaluate" },
        { false, "gsc-emit" },
        { false, "gsi" },
        { true, "gsc-evaluate" },
        { true, "gsc-emit" },
        { true, "gsi" },
    };

    [Theory]
    [MemberData(nameof(DriverMatrix))]
    public void CrossAssemblySymbolicNestedEnum_WorksAcrossScopesAndDrivers(bool inFunction, string driver)
    {
        var root = CreateRoot();
        try
        {
            var packageName = "glib" + Guid.NewGuid().ToString("N");
            var libraryPath = CompileLibrary(root, packageName);
            var sourcePath = Path.Combine(root, "consumer.gs");
            File.WriteAllText(sourcePath, BuildRuntimeSource(packageName, inFunction, driver != "gsc-evaluate"));

            var output = driver switch
            {
                "gsc-evaluate" => RunCompilerEvaluate(sourcePath, libraryPath),
                "gsc-emit" => RunCompilerEmit(root, sourcePath, libraryPath),
                "gsi" => RunInterpreter(sourcePath, libraryPath),
                _ => throw new InvalidOperationException("Unknown driver: " + driver),
            };

            Assert.Equal(driver == "gsc-evaluate" ? string.Empty : ExpectedOutput, output);
        }
        finally
        {
            DeleteRoot(root);
        }
    }

    [Fact]
    public void BoundLiteralType_RetainsSymbolicEnclosingArgument()
    {
        var root = CreateRoot();
        try
        {
            var packageName = "glib" + Guid.NewGuid().ToString("N");
            var libraryPath = CompileLibrary(root, packageName);
            using var references = ReferenceResolver.WithReferences(new[] { libraryPath });
            var tree = SyntaxTree.Parse($$"""
                package consumer

                struct Holder[T] {
                    func Read() int32 {
                        var c {{packageName}}.Outer[T].Color = {{packageName}}.Outer[T].Color.Green
                        return int32(c)
                    }
                }
                """);
            var compilation = new Compilation(references, tree) { IsLibrary = true };
            var errors = tree.Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where(diagnostic => diagnostic.IsError);
            Assert.Empty(errors);

            var function = compilation.BoundProgram.Functions.Keys.Single(symbol => symbol.Name == "Read");
            var collector = new ImportedLiteralCollector();
            collector.Visit(compilation.BoundProgram.Functions[function]);
            var literalType = Assert.Single(collector.Types);
            var typeArgument = Assert.IsType<TypeParameterSymbol>(Assert.Single(literalType.TypeArguments));

            Assert.Equal("T", typeArgument.Name);
            Assert.Equal("System.Object", Assert.Single(literalType.ClrType.GetGenericArguments()).FullName);
            Assert.Equal(packageName + ".Outer[T].Color", SymbolDisplay.ToTypeDisplayString(literalType));
        }
        finally
        {
            DeleteRoot(root);
        }
    }

    [Fact]
    public void ConversionDiagnostics_PreserveAllNeighbouringConstructions()
    {
        var root = CreateRoot();
        try
        {
            var packageName = "glib" + Guid.NewGuid().ToString("N");
            var libraryPath = CompileLibrary(root, packageName);
            var sourcePath = Path.Combine(root, "diagnostics.gs");
            File.WriteAllText(sourcePath, BuildDiagnosticSource(packageName));

            var result = Capture(() => GSharp.Compiler.Program.Main(new[]
            {
                "/nowarn:GS9100",
                "/r:" + libraryPath,
                sourcePath,
            }));
            var diagnostics = Normalize(result.Output + result.Error);

            Assert.Equal(1, result.ExitCode);
            Assert.Equal(5, CountOccurrences(diagnostics, "error GS0156:"));
            Assert.DoesNotContain("Outer[object]", diagnostics);
            Assert.Contains($"Cannot convert type '{packageName}.Outer[T].Color' to '{packageName}.Outer[string].Color'", diagnostics);
            Assert.Contains($"Cannot convert type '{packageName}.Outer[U].Color' to '{packageName}.Outer[int32].Color'", diagnostics);
            Assert.Contains($"Cannot convert type '{packageName}.Outer[int32].Color' to '{packageName}.Outer[string].Color'", diagnostics);
            Assert.Contains($"Cannot convert type '{packageName}.Outer[B].Color' to '{packageName}.Outer[int32].Color'", diagnostics);
        }
        finally
        {
            DeleteRoot(root);
        }
    }

    private static string CompileLibrary(string root, string packageName)
    {
        var sourcePath = Path.Combine(root, "library.gs");
        var outputDirectory = Path.Combine(root, "library-out");
        Directory.CreateDirectory(outputDirectory);
        var outputPath = Path.Combine(outputDirectory, packageName + ".dll");
        File.WriteAllText(sourcePath, $$"""
            package {{packageName}}

            public struct Outer[T] {
                public enum Color { Red = 11, Green = 22, Blue = 33 }
            }
            """);

        var result = Capture(() => GSharp.Compiler.Program.Main(new[]
        {
            "/target:library",
            "/out:" + outputPath,
            sourcePath,
        }));
        Assert.True(
            result.ExitCode == 0,
            $"Library compile failed ({result.ExitCode}):\nstdout:\n{result.Output}\nstderr:\n{result.Error}");
        return outputPath;
    }

    private static string RunCompilerEvaluate(string sourcePath, string libraryPath)
    {
        var result = Capture(() => GSharp.Compiler.Program.Main(new[]
        {
            "/nowarn:GS9100",
            "/r:" + libraryPath,
            sourcePath,
        }));
        Assert.True(
            result.ExitCode == 0,
            $"gsc evaluate failed ({result.ExitCode}):\nstdout:\n{result.Output}\nstderr:\n{result.Error}");

        var output = Normalize(result.Output);
        Assert.EndsWith("Success.\n", output);
        return output[..^"Success.\n".Length];
    }

    private static string RunCompilerEmit(string root, string sourcePath, string libraryPath)
    {
        var outputDirectory = Path.Combine(root, "consumer-out");
        Directory.CreateDirectory(outputDirectory);
        var outputPath = Path.Combine(outputDirectory, "consumer.dll");
        var compile = Capture(() => GSharp.Compiler.Program.Main(new[]
        {
            "/target:exe",
            "/out:" + outputPath,
            "/nowarn:GS9100",
            "/r:" + libraryPath,
            sourcePath,
        }));
        Assert.True(
            compile.ExitCode == 0,
            $"gsc emit failed ({compile.ExitCode}):\nstdout:\n{compile.Output}\nstderr:\n{compile.Error}");

        var library = Assembly.Load(File.ReadAllBytes(libraryPath));
        ResolveEventHandler resolve = (_, args) =>
            new AssemblyName(args.Name).Name == library.GetName().Name ? library : null;
        AppDomain.CurrentDomain.AssemblyResolve += resolve;
        try
        {
            var assembly = Assembly.Load(File.ReadAllBytes(outputPath));
            var allTypes = assembly.GetTypes();
            var program = allTypes.Single(type => type.Name == "<Program>");
            var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            var run = Capture(() =>
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                return 0;
            });
            Assert.Equal(0, run.ExitCode);
            Assert.Empty(run.Error);
            return Normalize(run.Output);
        }
        finally
        {
            AppDomain.CurrentDomain.AssemblyResolve -= resolve;
        }
    }

    private static string RunInterpreter(string sourcePath, string libraryPath)
    {
        _ = Assembly.Load(File.ReadAllBytes(libraryPath));
        var result = Capture(() => GSharp.Repl.Program.Main(new[] { sourcePath }));
        Assert.True(
            result.ExitCode == 0,
            $"gsi failed ({result.ExitCode}):\nstdout:\n{result.Output}\nstderr:\n{result.Error}");
        return Normalize(result.Output);
    }

    private static string BuildRuntimeSource(string packageName, bool inFunction, bool writeOutput)
    {
        var statements = writeOutput
            ? $$"""
                Console.WriteLine(Headline[int32]())
                Console.WriteLine(FromU[string]())
                Console.WriteLine(Concrete())
                Console.WriteLine(FromB[int32, string]())
                Console.WriteLine(int32({{packageName}}.Outer[int32].Color.Blue))
                Console.WriteLine(int32({{packageName}}.Outer[string].Color.Red))
                """
            : $$"""
                var r1 = Headline[int32]()
                var r2 = FromU[string]()
                var r3 = Concrete()
                var r4 = FromB[int32, string]()
                var r5 = int32({{packageName}}.Outer[int32].Color.Blue)
                var r6 = int32({{packageName}}.Outer[string].Color.Red)
                """;
        var execution = inFunction
            ? "func Run() {\n" + Indent(statements) + "\n}\nRun()"
            : statements;

        return $$"""
            package consumer
            import System

            func Headline[T]() int32 {
                var c {{packageName}}.Outer[T].Color = {{packageName}}.Outer[T].Color.Green
                return int32(c)
            }

            func FromU[U]() int32 {
                var c {{packageName}}.Outer[U].Color = {{packageName}}.Outer[U].Color.Blue
                return int32(c)
            }

            func Concrete() int32 {
                var c {{packageName}}.Outer[int32].Color = {{packageName}}.Outer[int32].Color.Red
                return int32(c)
            }

            func FromB[A, B]() int32 {
                var c {{packageName}}.Outer[B].Color = {{packageName}}.Outer[B].Color.Green
                return int32(c)
            }

            {{execution}}
            """;
    }

    private static string BuildDiagnosticSource(string packageName) => $$"""
        package consumer

        func Headline[T]() {
            var c {{packageName}}.Outer[T].Color = {{packageName}}.Outer[T].Color.Green
        }

        func FromT[T]() {
            var c {{packageName}}.Outer[string].Color = {{packageName}}.Outer[T].Color.Red
        }

        func FromU[U]() {
            var c {{packageName}}.Outer[int32].Color = {{packageName}}.Outer[U].Color.Red
        }

        func FromConcrete() {
            var c {{packageName}}.Outer[string].Color = {{packageName}}.Outer[int32].Color.Red
        }

        func FromB[A, B]() {
            var c {{packageName}}.Outer[int32].Color = {{packageName}}.Outer[B].Color.Red
        }

        func IntToString() {
            var a {{packageName}}.Outer[int32].Color = {{packageName}}.Outer[int32].Color.Red
            var b {{packageName}}.Outer[string].Color = a
        }
        """;

    private static string CreateRoot()
    {
        var root = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2947ImportedNestedEnumSymbolicTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static void DeleteRoot(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch
        {
        }
    }

    private static RunResult Capture(Func<int> action)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var previousOutput = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            return new RunResult(action(), output.ToString(), error.ToString());
        }
        finally
        {
            Console.SetOut(previousOutput);
            Console.SetError(previousError);
        }
    }

    private static string Indent(string text) =>
        string.Join("\n", Normalize(text).TrimEnd('\n').Split('\n').Select(line => "    " + line));

    private static string Normalize(string text) => text.Replace("\r\n", "\n");

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        for (var index = text.IndexOf(value, StringComparison.Ordinal);
             index >= 0;
             index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private sealed class ImportedLiteralCollector : BoundTreeWalker
    {
        public List<ImportedTypeSymbol> Types { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundLiteralExpression
                && node.Type is ImportedTypeSymbol { OpenDefinition: not null } imported
                && imported.OpenDefinition.Name.StartsWith("Color", StringComparison.Ordinal))
            {
                Types.Add(imported);
            }

            base.VisitExpression(node);
        }
    }

    private readonly record struct RunResult(int ExitCode, string Output, string Error);
}
