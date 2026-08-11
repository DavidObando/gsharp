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
/// Issue #3099: emitted generic backing types must preserve every
/// G# type-argument kind instead of erasing value types to <see cref="object"/>.
/// Issue #3137 extends the same emit-oracle matrix to reflected field shape.
/// Issue #3180 covers enclosing generic parameters in the interactive emitted
/// engine; ADR-0156 file drivers remain compared against explicit and interactive
/// emitted hosts. Issue #3255 covers composite types in enclosing generic arguments.
/// </summary>
[Collection("ConsoleIo")]
public class Issue3099TypeArgumentReificationTests
{
    [Fact]
    public void CompositeEnclosingTypeArguments_ReifyAcrossEmittedHosts()
    {
        const string Source = """
            package Issue3255
            import System
            import Gsharp.Extensions.Go

            class Box[T] {
            }

            class Owner[T] {
                class Payload[U] {
                }
            }

            func Reify[T]() {
                let channelValue = Box[Owner[chan T].Payload[string]]()
                let channelType = channelValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                Console.WriteLine("chan:" + channelType.GetGenericTypeDefinition().FullName)
                Console.WriteLine("chan-arg:" + channelType.GenericTypeArguments[0].FullName)

                let sequenceValue = Box[Owner[sequence[T]].Payload[string]]()
                let sequenceType = sequenceValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                Console.WriteLine("sequence:" + sequenceType.GetGenericTypeDefinition().FullName)
                Console.WriteLine("sequence-arg:" + sequenceType.GenericTypeArguments[0].FullName)

                let mapValue = Box[Owner[map[string,T]].Payload[string]]()
                let mapType = mapValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                Console.WriteLine("map:" + mapType.GetGenericTypeDefinition().FullName)
                Console.WriteLine("map-key:" + mapType.GenericTypeArguments[0].FullName)
                Console.WriteLine("map-value:" + mapType.GenericTypeArguments[1].FullName)

                let asyncSequenceValue = Box[Owner[async sequence[T]].Payload[string]]()
                let asyncSequenceType = asyncSequenceValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                Console.WriteLine("async-sequence:" + asyncSequenceType.GetGenericTypeDefinition().FullName)
                Console.WriteLine("async-sequence-arg:" + asyncSequenceType.GenericTypeArguments[0].FullName)

                let deepValue = Box[Owner[map[string,sequence[chan T]]].Payload[string]]()
                let deepMap = deepValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                let deepSequence = deepMap.GenericTypeArguments[1]
                let deepChannel = deepSequence.GenericTypeArguments[0]
                Console.WriteLine("deep-map:" + deepMap.GetGenericTypeDefinition().FullName)
                Console.WriteLine("deep-sequence:" + deepSequence.GetGenericTypeDefinition().FullName)
                Console.WriteLine("deep-channel:" + deepChannel.GetGenericTypeDefinition().FullName)
                Console.WriteLine("deep-arg:" + deepChannel.GenericTypeArguments[0].FullName)
            }

            Reify[int32]()
            """;
        string Expected =
            $"chan:System.Threading.Channels.Channel`1{Environment.NewLine}"
            + $"chan-arg:System.Int32{Environment.NewLine}"
            + $"sequence:System.Collections.Generic.IEnumerable`1{Environment.NewLine}"
            + $"sequence-arg:System.Int32{Environment.NewLine}"
            + $"map:System.Collections.Generic.Dictionary`2{Environment.NewLine}"
            + $"map-key:System.String{Environment.NewLine}"
            + $"map-value:System.Int32{Environment.NewLine}"
            + $"async-sequence:System.Collections.Generic.IAsyncEnumerable`1{Environment.NewLine}"
            + $"async-sequence-arg:System.Int32{Environment.NewLine}"
            + $"deep-map:System.Collections.Generic.Dictionary`2{Environment.NewLine}"
            + $"deep-sequence:System.Collections.Generic.IEnumerable`1{Environment.NewLine}"
            + $"deep-channel:System.Threading.Channels.Channel`1{Environment.NewLine}"
            + $"deep-arg:System.Int32{Environment.NewLine}";
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3255-{Guid.NewGuid():N}");

        try
        {
            var compiler = RunSourceDriver(
                Path.Combine(root, "gsc"),
                Source,
                Program.Main);
            var gsi = RunSourceDriver(
                Path.Combine(root, "gsi"),
                Source,
                GSharp.Repl.Program.Main);
            var interactive = RunInteractiveEmit(Source);

            Assert.Equal(Expected + $"Success.{Environment.NewLine}", compiler);
            Assert.Equal(Expected, gsi);
            Assert.Equal(Expected, interactive);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void LegacyFunctionEnclosingTypeArgument_CompilesAndRuns()
    {
        const string Source = """
            package Issue3255LegacyFunction
            import System
            class Box[T] {}
            class Owner[T] { class Payload[U] {} }
            func Reify() {
                let value = Box[Owner[func(int32) int32].Payload[string]]()
                let functionType = value.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                Console.WriteLine("func:" + functionType.GetGenericTypeDefinition().FullName)
                Console.WriteLine("func-arg:" + functionType.GenericTypeArguments[0].FullName)
                Console.WriteLine("func-return:" + functionType.GenericTypeArguments[1].FullName)
            }
            Reify()
            """;
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3255-legacy-function-{Guid.NewGuid():N}");

        try
        {
            var output = RunSourceDriver(root, Source, Program.Main);
            Assert.Contains(
                $"func:System.Func`2{Environment.NewLine}func-arg:System.Int32{Environment.NewLine}func-return:System.Int32{Environment.NewLine}",
                output,
                StringComparison.Ordinal);
            Assert.Contains("warning GS0303:", output, StringComparison.Ordinal);
            Assert.EndsWith($"Success.{Environment.NewLine}", output, StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void PointerEnclosingTypeArgument_RemainsRejectedBeforeEmit()
    {
        const string Source = """
            package Issue3255Pointer
            class Box[T] {}
            class Owner[T] { class Payload[U] {} }
            func Reify[T]() {
                let value = Box[Owner[*int32].Payload[string]]()
            }
            """;
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3255-pointer-{Guid.NewGuid():N}");

        try
        {
            var probeDirectory = PrepareEmptyDirectory(root);
            var sourcePath = Path.Combine(probeDirectory, "Probe.gs");
            File.WriteAllText(sourcePath, Source);
            var result = CaptureDriverResult(() => Program.Main([sourcePath]));

            Assert.Equal(1, result.ExitCode);
            Assert.Contains(
                "(5,28,5,33): error GS0125: Variable 'int32' doesn't exist.",
                result.Stdout,
                StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Stdout, StringComparison.Ordinal);
            Assert.DoesNotContain("Cannot encode", result.Stdout, StringComparison.Ordinal);
            Assert.Equal($"Failed.{Environment.NewLine}", result.Stderr);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public void ManagedFunctionPointerEnclosingTypeArgument_ReportsAnchoredDiagnostic()
    {
        const string Source = """
            package Issue3255ManagedFunctionPointer
            import System
            import Gsharp.Extensions.Go
            class Box[T] {}
            class Owner[T] { class Payload[U] {} }
            unsafe func Reify[T]() {
                let value = Box[Owner[*func(int32) int32].Payload[string]]()
                let enclosing = value.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
                Console.WriteLine(enclosing.FullName)
            }
            Reify[int32]()
            """;
        var root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            $"issue3255-managed-function-pointer-{Guid.NewGuid():N}");

        try
        {
            var probeDirectory = PrepareEmptyDirectory(root);
            var sourcePath = Path.Combine(probeDirectory, "Probe.gs");
            File.WriteAllText(sourcePath, Source);
            var result = CaptureDriverResult(() => Program.Main([sourcePath]));

            Assert.Equal(1, result.ExitCode);
            Assert.Contains(
                "(7,27,7,45): error GS0521: Pointer and function-pointer types cannot be used as generic type arguments.",
                result.Stdout,
                StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Stdout, StringComparison.Ordinal);
            Assert.DoesNotContain("Cannot encode", result.Stdout, StringComparison.Ordinal);
            Assert.Equal($"Failed.{Environment.NewLine}", result.Stderr);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

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
    public void TypeArguments_AgreeAcrossEmittedHostsAndFileDrivers(
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
            var gscScript = RunSourceDriver(
                Path.Combine(root, "gsc-script"),
                source,
                Program.Main);
            var successSuffix = $"Success.{Environment.NewLine}";
            Assert.EndsWith(successSuffix, gscScript);
            gscScript = gscScript[..^successSuffix.Length];

            var gsiScript = RunSourceDriver(
                Path.Combine(root, "gsi"),
                source,
                GSharp.Repl.Program.Main);
            var interactiveEmit = RunInteractiveEmit(source);

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

            var explicitEmit = CollectibleAssembly.Inspect(
                assemblyPath,
                assembly =>
                {
                    Assert.Contains(assembly.GetTypes(), type => type.FullName?.EndsWith(".Box`1", StringComparison.Ordinal) == true);
                    Assert.Contains(assembly.GetTypes(), type => type.FullName?.EndsWith(".Pair`2", StringComparison.Ordinal) == true);
                    var entryPoint = assembly.EntryPoint
                        ?? throw new InvalidOperationException("Emitted assembly has no entry point.");
                    return CaptureDriver(() =>
                    {
                        entryPoint.Invoke(
                            null,
                            entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
                        return 0;
                    });
                });

            var expected = NormalizeGenericTypeNames(explicitEmit);
            var interactiveOutput = NormalizeGenericTypeNames(interactiveEmit);
            var gscOutput = NormalizeGenericTypeNames(gscScript);
            var gsiOutput = NormalizeGenericTypeNames(gsiScript);
            var controlShape =
                $"44{Environment.NewLine}2|Eleven:System.Int32:True:False:False|TwentyTwo:System.String:False:False:False{Environment.NewLine}";
            Assert.Contains(controlShape, expected, StringComparison.Ordinal);
            Assert.Contains(controlShape, interactiveOutput, StringComparison.Ordinal);
            Assert.Contains(controlShape, gscOutput, StringComparison.Ordinal);
            Assert.Contains(controlShape, gsiOutput, StringComparison.Ordinal);
            Assert.Equal(expected, interactiveOutput);
            Assert.Equal(expected, gscOutput);
            Assert.Equal(expected, gsiOutput);
            Assert.Contains($"11{Environment.NewLine}", expected);
            Assert.Contains($"22{Environment.NewLine}", expected);
            Assert.Contains($"33{Environment.NewLine}", expected);
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

    private static string RunInteractiveEmit(string source)
    {
        // ADR-0156 Phase 3c (#3176): the interactive column runs on the
        // emitted submission-chaining engine.
        using var engine = new EmittedSessionEngine { CaptureConsole = true };
        var cell = engine.Evaluate(source);
        Assert.False(cell.HasError, string.Join(Environment.NewLine, cell.Diagnostics));
        return cell.Output.ReplaceLineEndings(Environment.NewLine);
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
        var result = CaptureDriverResult(driver);
        Assert.True(
            result.ExitCode == 0,
            $"driver failed with exit {result.ExitCode}\nstdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        return result.Stdout;
    }

    private static DriverResult CaptureDriverResult(Func<int> driver)
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

        return new DriverResult(
            exit,
            stdout.ToString().ReplaceLineEndings(Environment.NewLine),
            stderr.ToString().ReplaceLineEndings(Environment.NewLine));
    }

    private readonly record struct DriverResult(int ExitCode, string Stdout, string Stderr);

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
