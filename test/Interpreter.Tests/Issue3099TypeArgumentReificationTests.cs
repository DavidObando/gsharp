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
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3099: interpreter-created generic backing types must preserve every
/// G# type-argument kind instead of erasing value types to <see cref="object"/>.
/// Issue #3137 extends the same emit-oracle matrix to reflected field shape.
/// Issue #3180 covers enclosing generic parameters in the interactive evaluator;
/// ADR-0156 file drivers remain compared against the emitted oracle.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3099TypeArgumentReificationTests
{
    public static IEnumerable<object[]> TypeArgumentCases()
    {
        yield return ["class", "class Payload {\n    let Eleven int32\n    var TwentyTwo string\n}", "Payload"];
        yield return ["struct", "struct Payload {\n    let Eleven int32\n    var TwentyTwo string\n}", "Payload"];
        yield return ["enum", "enum Payload {\n    Eleven = 11,\n    TwentyTwo = 22,\n    ThirtyThree = 33,\n}", "Payload"];
        yield return ["string", string.Empty, "string"];
        yield return ["nested-class", "class Owner {\n    class Payload {\n        let Eleven int32\n        var TwentyTwo string\n    }\n}", "Owner.Payload"];
        yield return ["nested-struct", "class Owner {\n    struct Payload {\n        let Eleven int32\n        var TwentyTwo string\n    }\n}", "Owner.Payload"];
        yield return ["generic-owner-nested-class", "class Owner[T] {\n    class Payload {\n        let Eleven T\n        var TwentyTwo string\n    }\n}", "Owner[int32].Payload"];
        yield return ["generic-owner-nested-struct", "class Owner[T] {\n    struct Payload {\n        let Eleven T\n        var TwentyTwo string\n    }\n}", "Owner[int32].Payload"];
        yield return ["generic-owner-multi-arity-nested", "class Owner[TFirst, TSecond] {\n    class Payload {\n        let Eleven TFirst\n        var TwentyTwo TSecond\n    }\n}", "Owner[int32, string].Payload"];
        yield return ["generic-owner-nested-generic", "class Owner[T] {\n    class Payload[U] {\n        let Eleven T\n        var TwentyTwo U\n    }\n}", "Owner[int32].Payload[string]"];
        yield return ["generic-owner-deep-nested", "class Owner[T] {\n    class Middle[U] {\n        class Payload {\n            let Eleven T\n            var TwentyTwo U\n        }\n    }\n}", "Owner[int32].Middle[string].Payload"];
        yield return ["gsharp-generic", "struct Payload[T] {\n    let Value T\n    var Imported List[T]\n    var Slice []T\n    var Nullable T?\n    var Array [3]T\n    shared {\n        var Stat int32\n    }\n    const Kilo int32 = 1000\n}", "Payload[int32]"];
        yield return ["imported-generic", "struct Payload {\n    let Eleven int32\n    var TwentyTwo string\n}", "List[Payload]"];
        yield return ["nullable", "struct Payload {\n    let Eleven int32\n    var TwentyTwo string\n}", "Payload?"];
        yield return ["slice", "struct Payload {\n    let Eleven int32\n    var TwentyTwo string\n}", "[]Payload"];
        yield return ["array", "struct Payload {\n    let Eleven int32\n    var TwentyTwo string\n}", "[3]Payload"];
    }

    [Theory]
    [MemberData(nameof(TypeArgumentCases))]
    public void TypeArguments_AgreeAcrossInteractiveEvaluationEmitAndFileDrivers(
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
            var compilerFile = RunSourceDriver(
                Path.Combine(root, "gsc-eval"),
                source,
                Program.Main);
            Assert.EndsWith("Success.\n", compilerFile);
            compilerFile = compilerFile[..^"Success.\n".Length];

            var gsiFile = RunSourceDriver(
                Path.Combine(root, "gsi"),
                source,
                GSharp.Repl.Program.Main);
            var interactive = RunInteractive(source);

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
            var evaluated = NormalizeGenericTypeNames(interactive);
            var compiledFile = NormalizeGenericTypeNames(compilerFile);
            var interpretedFile = NormalizeGenericTypeNames(gsiFile);
            const string ControlShape =
                "44\n2|Eleven:System.Int32:True:False:False|TwentyTwo:System.String:False:False:False\n";
            Assert.Contains(ControlShape, expected, StringComparison.Ordinal);
            Assert.Contains(ControlShape, evaluated, StringComparison.Ordinal);
            Assert.Contains(ControlShape, compiledFile, StringComparison.Ordinal);
            Assert.Contains(ControlShape, interpretedFile, StringComparison.Ordinal);
            Assert.Equal(expected, evaluated);
            Assert.Equal(expected, compiledFile);
            Assert.Equal(expected, interpretedFile);
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

            struct ReflectionControl {
                let Eleven int32
                var TwentyTwo string
            }

            class Box[T] : EventArgs {
            }

            class Pair[TFirst, TSecond] : EventArgs {
            }

            func FieldShape(t Type) string {
                var shape = t.GetFields().Length.ToString()
                for field in t.GetFields() {
                    shape = shape + "|" + field.Name + ":" + field.FieldType.FullName + ":" + field.IsInitOnly.ToString() + ":" + field.IsStatic.ToString() + ":" + field.IsLiteral.ToString()
                    if field.IsLiteral {
                        shape = shape + ":" + field.GetRawConstantValue().ToString()
                    }
                }
                return shape
            }

            var single = Box[__TYPE__]()
            Console.WriteLine(11)
            Console.WriteLine(single.GetType().FullName)
            Console.WriteLine(single.GetType().GenericTypeArguments[0].IsValueType)
            Console.WriteLine(single.GetType().GenericTypeArguments[0].IsEnum)
            Console.WriteLine(single.GetType().GenericTypeArguments[0].IsLayoutSequential)
            Console.WriteLine(FieldShape(single.GetType().GenericTypeArguments[0]))
            var multiple = Pair[__TYPE__, int32]()
            Console.WriteLine(22)
            Console.WriteLine(multiple.GetType().FullName)
            Console.WriteLine(Object.ReferenceEquals(
                single.GetType().GenericTypeArguments[0],
                multiple.GetType().GenericTypeArguments[0]))
            Console.WriteLine(FieldShape(multiple.GetType().GenericTypeArguments[0]))
            Console.WriteLine(33)
            var nested = Box[Box[__TYPE__]]()
            Console.WriteLine(nested.GetType().FullName)
            Console.WriteLine(FieldShape(nested.GetType().GenericTypeArguments[0].GenericTypeArguments[0]))
            var control = Box[ReflectionControl]()
            Console.WriteLine(44)
            Console.WriteLine(FieldShape(control.GetType().GenericTypeArguments[0]))
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

    private static string RunInteractive(string source)
    {
        // ADR-0156 Phase 3c (#3176): the interactive column runs on the
        // emitted submission-chaining engine.
        using var engine = new EmittedSessionEngine { CaptureConsole = true };
        var cell = engine.Evaluate(source);
        Assert.False(cell.HasError, string.Join(Environment.NewLine, cell.Diagnostics));
        return cell.Output.Replace("\r\n", "\n", StringComparison.Ordinal);
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
