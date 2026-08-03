// <copyright file="Issue3099TypeArgumentReificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3099: interpreter-created generic backing types must preserve every
/// G# type-argument kind instead of erasing value types to <see cref="object"/>.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3099TypeArgumentReificationTests
{
    public static IEnumerable<object[]> TypeArgumentCases()
    {
        yield return ["class", "class Payload {\n}", "Payload"];
        yield return ["struct", "struct Payload {\n    var Value int32\n}", "Payload"];
        yield return ["enum", "enum Payload {\n    Eleven = 11,\n    TwentyTwo = 22,\n    ThirtyThree = 33,\n}", "Payload"];
        yield return ["string", string.Empty, "string"];
        yield return ["nested-class", "class Owner {\n    class Payload {\n    }\n}", "Owner.Payload"];
        yield return ["nested-struct", "class Owner {\n    struct Payload {\n        var Value int32\n    }\n}", "Owner.Payload"];
        yield return ["gsharp-generic", "struct Payload[T] {\n    var Value T\n}", "Payload[int32]"];
        yield return ["imported-generic", "struct Payload {\n    var Value int32\n}", "List[Payload]"];
        yield return ["nullable", "struct Payload {\n    var Value int32\n}", "Payload?"];
        yield return ["slice", "struct Payload {\n    var Value int32\n}", "[]Payload"];
        yield return ["array", "struct Payload {\n    var Value int32\n}", "[3]Payload"];
    }

    [Theory]
    [MemberData(nameof(TypeArgumentCases))]
    public void TypeArguments_AgreeAcrossEvaluationEmitAndInterpretation(
        string caseName,
        string declaration,
        string typeArgument)
    {
        var source = CreateSource(caseName, declaration, typeArgument);
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3099-{caseName}-{Guid.NewGuid():N}");

        try
        {
            var compilerEvaluation = RunSourceDriver(
                Path.Combine(root, "gsc-eval"),
                source,
                Program.Main);
            Assert.EndsWith("Success.\n", compilerEvaluation);
            compilerEvaluation = compilerEvaluation[..^"Success.\n".Length];

            var interpreter = RunSourceDriver(
                Path.Combine(root, "gsi"),
                source,
                GSharp.Repl.Program.Main);

            var emitDirectory = PrepareEmptyDirectory(Path.Combine(root, "gsc-emit"));
            var sourcePath = Path.Combine(emitDirectory, "Probe.gs");
            var assemblyPath = Path.Combine(emitDirectory, "Probe.dll");
            File.WriteAllText(sourcePath, source);
            _ = CaptureDriver(() => Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            }));

            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            Assert.Contains(assembly.GetTypes(), type => type.FullName?.EndsWith(".Box`1", StringComparison.Ordinal) == true);
            Assert.Contains(assembly.GetTypes(), type => type.FullName?.EndsWith(".Pair`2", StringComparison.Ordinal) == true);
            var entryPoint = assembly.EntryPoint
                ?? throw new InvalidOperationException("Emitted assembly has no entry point.");
            var emitted = CaptureDriver(() =>
            {
                entryPoint.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                return 0;
            });

            var expected = NormalizeGenericTypeNames(emitted);
            Assert.Equal(expected, NormalizeGenericTypeNames(compilerEvaluation));
            Assert.Equal(expected, NormalizeGenericTypeNames(interpreter));
            Assert.Contains("11\n", expected);
            Assert.Contains("22\n", expected);
            Assert.Contains("33\n", expected);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    private static string CreateSource(string caseName, string declaration, string typeArgument)
    {
        const string Template = """
            package Issue3099.__CASE__
            import System
            import System.Collections.Generic

            __DECLARATION__

            class Box[T] : EventArgs {
            }

            class Pair[TFirst, TSecond] : EventArgs {
            }

            var single = Box[__TYPE__]()
            Console.WriteLine(11)
            Console.WriteLine(single.GetType().FullName)
            Console.WriteLine(single.GetType().GenericTypeArguments[0].IsValueType)
            Console.WriteLine(single.GetType().GenericTypeArguments[0].IsEnum)
            Console.WriteLine(single.GetType().GenericTypeArguments[0].IsLayoutSequential)
            var multiple = Pair[__TYPE__, int32]()
            Console.WriteLine(22)
            Console.WriteLine(multiple.GetType().FullName)
            Console.WriteLine(Object.ReferenceEquals(
                single.GetType().GenericTypeArguments[0],
                multiple.GetType().GenericTypeArguments[0]))
            Console.WriteLine(33)
            Console.WriteLine(Box[Box[__TYPE__]]().GetType().FullName)
            """;

        return Template
            .Replace("__CASE__", "Case" + caseName.Replace("-", string.Empty, StringComparison.Ordinal), StringComparison.Ordinal)
            .Replace("__DECLARATION__", declaration, StringComparison.Ordinal)
            .Replace("__TYPE__", typeArgument, StringComparison.Ordinal);
    }

    private static string RunSourceDriver(string directory, string source, Func<string[], int> driver)
    {
        var probeDirectory = PrepareEmptyDirectory(directory);
        var sourcePath = Path.Combine(probeDirectory, "Probe.gs");
        File.WriteAllText(sourcePath, source);
        return CaptureDriver(() => driver([sourcePath]));
    }

    private static string PrepareEmptyDirectory(string directory)
    {
        Assert.False(Directory.Exists(directory), $"probe directory already exists: {directory}");
        Directory.CreateDirectory(directory);
        Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
        return directory;
    }

    private static string CaptureDriver(Func<int> driver)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exit;
        try
        {
            exit = driver();
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exit == 0,
            $"driver failed with exit {exit}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string NormalizeGenericTypeNames(string output)
    {
        return Regex.Replace(
            output,
            @", [^,\[\]]+, Version=[^,\[\]]+, Culture=[^,\[\]]+, PublicKeyToken=[^,\[\]]+",
            string.Empty,
            RegexOptions.CultureInvariant);
    }

    private static string GetRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new InvalidOperationException("Could not locate repository root.");
    }
}
