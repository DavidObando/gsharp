// <copyright file="Issue2494EnumLinqExtremaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end regression coverage for issue #2494. Imported generic LINQ
/// extrema and sibling generic-return paths must retain a same-compilation
/// enum in binding, emitted signatures, MethodSpecs, and runtime values rather
/// than exposing the enum's temporary <c>int32</c> lookup projection.
/// </summary>
public sealed class Issue2494EnumLinqExtremaEmitTests
{
    private const string ImportedEnumsCSharpSource = """
        namespace Issue2494.Imported;

        public enum SByteChoice : sbyte { Low, High }
        public enum ByteChoice : byte { Low, High }
        public enum Int16Choice : short { Low, High }
        public enum UInt16Choice : ushort { Low, High }
        public enum Int32Choice : int { Low, High }
        public enum UInt32Choice : uint { Low, High }
        public enum Int64Choice : long { Low, High }
        public enum UInt64Choice : ulong { Low, High }
        """;

    [Fact]
    public void SourceEnum_AllReceiverAndGenericReturnShapes_CompileRunAndIlVerify()
    {
        const string source = """
            package Issue2494.SourceRuntime
            import System
            import System.Collections.Generic
            import System.Linq

            enum Choice2494 { Low, Middle, High }
            data class Item2494(State Choice2494, Optional Choice2494?) {}

            func GenericMin[T](values IEnumerable[T]) T -> values.Min()
            func GenericMax[T](values IEnumerable[T]) T -> values.Max()
            func ArrayMin(values []Choice2494) Choice2494 -> values.Min()
            func ArrayMax(values []Choice2494) Choice2494 -> values.Max()
            func EnumerableMin(values IEnumerable[Choice2494]) Choice2494 -> values.Min()
            func EnumerableMax(values IEnumerable[Choice2494]) Choice2494 -> values.Max()
            func ListMin(values List[Choice2494]) Choice2494 -> values.Min()
            func ListMax(values List[Choice2494]) Choice2494 -> values.Max()
            func StaticMin(values []Choice2494) Choice2494 -> Enumerable.Min(values)
            func StaticMax(values []Choice2494) Choice2494 -> Enumerable.Max(values)
            func DictionaryValuesMin(values Dictionary[string, Choice2494]) Choice2494 ->
                values.Values.Min()
            func PipelineMin(values []Choice2494) Choice2494 ->
                values.Select((value Choice2494) -> value).Distinct().Min()
            func PipelineMax(values []Choice2494) Choice2494 ->
                values.Select((value Choice2494) -> value).Distinct().Max()
            func NullableMin(values []Choice2494?) Choice2494? -> values.Min()
            func NullableMax(values []Choice2494?) Choice2494? -> values.Max()
            func SelectorMin(values []Item2494) Choice2494 ->
                values.Min((item Item2494) -> item.State)
            func SelectorMax(values []Item2494) Choice2494 ->
                values.Max((item Item2494) -> item.State)
            func NullableSelectorMin(values []Item2494) Choice2494? ->
                values.Min((item Item2494) -> item.Optional)
            func NullableSelectorMax(values []Item2494) Choice2494? ->
                values.Max((item Item2494) -> item.Optional)

            func main() {
                let array = []Choice2494{Choice2494.Low, Choice2494.Middle, Choice2494.High}
                let enumerable IEnumerable[Choice2494] = array
                let list = List[Choice2494]()
                list.Add(Choice2494.High)
                list.Add(Choice2494.Low)

                Console.WriteLine(ArrayMin(array) == Choice2494.Low)
                Console.WriteLine(ArrayMax(array) == Choice2494.High)
                Console.WriteLine(EnumerableMin(enumerable) == Choice2494.Low)
                Console.WriteLine(EnumerableMax(enumerable) == Choice2494.High)
                Console.WriteLine(ListMin(list) == Choice2494.Low)
                Console.WriteLine(ListMax(list) == Choice2494.High)
                Console.WriteLine(StaticMin(array) == Choice2494.Low)
                Console.WriteLine(StaticMax(array) == Choice2494.High)
                let dictionary = Dictionary[string, Choice2494]()
                dictionary.Add("high", Choice2494.High)
                dictionary.Add("low", Choice2494.Low)
                Console.WriteLine(DictionaryValuesMin(dictionary) == Choice2494.Low)
                Console.WriteLine(PipelineMin(array) == Choice2494.Low)
                Console.WriteLine(PipelineMax(array) == Choice2494.High)

                let nullable = []Choice2494?{nil, Choice2494.High, Choice2494.Low}
                Console.WriteLine(NullableMin(nullable) == Choice2494.Low)
                Console.WriteLine(NullableMax(nullable) == Choice2494.High)

                let items = []Item2494{
                    Item2494(Choice2494.Middle, Choice2494.High),
                    Item2494(Choice2494.High, nil),
                    Item2494(Choice2494.Low, Choice2494.Low),
                }
                Console.WriteLine(SelectorMin(items) == Choice2494.Low)
                Console.WriteLine(SelectorMax(items) == Choice2494.High)
                Console.WriteLine(NullableSelectorMin(items) == Choice2494.Low)
                Console.WriteLine(NullableSelectorMax(items) == Choice2494.High)

                Console.WriteLine(GenericMin[Choice2494](array) == Choice2494.Low)
                Console.WriteLine(GenericMax[Choice2494](array) == Choice2494.High)

                Console.WriteLine(array.First() == Choice2494.Low)
                Console.WriteLine(array.FirstOrDefault() == Choice2494.Low)
                Console.WriteLine([]Choice2494{Choice2494.Middle}.Single() == Choice2494.Middle)
                Console.WriteLine(array.ElementAt(2) == Choice2494.High)
                Console.WriteLine(array.Last() == Choice2494.High)
            }

            main()
            """;

        Assert.Equal(
            string.Concat(Enumerable.Repeat("True\n", 24)),
            CompileAndRun(source));
    }

    [Fact]
    public void SourceEnum_ReflectedReturnTypes_RemainTheEmittedEnum()
    {
        const string source = """
            package Issue2494.Reflection
            import System.Collections.Generic
            import System.Linq

            enum Choice2494 { Low, Middle, High }
            data class Item2494(State Choice2494, Optional Choice2494?) {}

            func GenericMin[T](values IEnumerable[T]) T -> values.Min()

            class ExtremaApi2494 {
                func ArrayMin(values []Choice2494) Choice2494 -> values.Min()
                func ListMax(values List[Choice2494]) Choice2494 -> values.Max()
                func NullableMin(values []Choice2494?) Choice2494? -> values.Min()
                func SelectorMax(values []Item2494) Choice2494 ->
                    values.Max((item Item2494) -> item.State)
                func WrappedMin(values []Choice2494) Choice2494 ->
                    GenericMin[Choice2494](values)
                func FirstValue(values []Choice2494) Choice2494 -> values.First()
            }
            """;

        var assembly = CompileToAssembly(source);
        var enumType = assembly.GetType("Issue2494.Reflection.Choice2494", throwOnError: true)!;
        var apiType = assembly.GetType("Issue2494.Reflection.ExtremaApi2494", throwOnError: true)!;

        Assert.Equal(enumType, GetMethod(apiType, "ArrayMin").ReturnType);
        Assert.Equal(enumType, GetMethod(apiType, "ListMax").ReturnType);
        Assert.Equal(enumType, GetMethod(apiType, "SelectorMax").ReturnType);
        Assert.Equal(enumType, GetMethod(apiType, "WrappedMin").ReturnType);
        Assert.Equal(enumType, GetMethod(apiType, "FirstValue").ReturnType);

        var nullableReturn = GetMethod(apiType, "NullableMin").ReturnType;
        Assert.Equal(typeof(Nullable<>), nullableReturn.GetGenericTypeDefinition());
        Assert.Equal(enumType, nullableReturn.GetGenericArguments()[0]);
    }

    [Fact]
    public void SourceEnum_CSharpConsumer_SeesEnumTypedExtremaApi()
    {
        const string source = """
            package Issue2494.Consumer
            import System.Linq

            enum Choice2494 { Low, Middle, High }

            class ExtremaApi2494 {
                shared {
                    func Min(values []Choice2494) Choice2494 -> values.Min()
                    func Max(values []Choice2494) Choice2494 -> values.Max()
                }
            }
            """;
        const string consumerSource = """
            using Issue2494.Consumer;

            public static class Consumer2494
            {
                public static bool Verify()
                {
                    Choice2494[] values = [Choice2494.High, Choice2494.Low];
                    Choice2494 min = ExtremaApi2494.Min(values);
                    Choice2494 max = ExtremaApi2494.Max(values);
                    return min == Choice2494.Low && max == Choice2494.High;
                }
            }
            """;

        var workDir = Directory.CreateTempSubdirectory("gs_issue2494_consumer_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(
                workDir,
                source,
                target: "library",
                csharpSource: null);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outPath, additionalReferences: references);

            var compilation = CSharpCompilation.Create(
                "Issue2494.ConsumerProbe",
                new[] { CSharpSyntaxTree.ParseText(consumerSource) },
                TrustedPlatformAssemblies()
                    .Select(path => MetadataReference.CreateFromFile(path))
                    .Append(MetadataReference.CreateFromFile(outPath)),
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var stream = new MemoryStream();
            var result = compilation.Emit(stream);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    [Fact]
    public void ImportedEnums_AllIntegralUnderlyingTypes_MinMaxRemainEnumTyped()
    {
        const string source = """
            package Issue2494.ImportedRuntime
            import System
            import System.Collections.Generic
            import System.Linq
            import Issue2494.Imported

            func GenericMin[T](values IEnumerable[T]) T -> values.Min()
            func GenericMax[T](values IEnumerable[T]) T -> values.Max()

            func PrintExtrema[T](values []T) {
                Console.WriteLine(GenericMin[T](values))
                Console.WriteLine(GenericMax[T](values))
            }

            PrintExtrema[SByteChoice]([]SByteChoice{SByteChoice.High, SByteChoice.Low})
            PrintExtrema[ByteChoice]([]ByteChoice{ByteChoice.High, ByteChoice.Low})
            PrintExtrema[Int16Choice]([]Int16Choice{Int16Choice.High, Int16Choice.Low})
            PrintExtrema[UInt16Choice]([]UInt16Choice{UInt16Choice.High, UInt16Choice.Low})
            PrintExtrema[Int32Choice]([]Int32Choice{Int32Choice.High, Int32Choice.Low})
            PrintExtrema[UInt32Choice]([]UInt32Choice{UInt32Choice.High, UInt32Choice.Low})
            PrintExtrema[Int64Choice]([]Int64Choice{Int64Choice.High, Int64Choice.Low})
            PrintExtrema[UInt64Choice]([]UInt64Choice{UInt64Choice.High, UInt64Choice.Low})
            """;

        Assert.Equal(
            string.Concat(Enumerable.Repeat("Low\nHigh\n", 8)),
            CompileAndRun(source, ImportedEnumsCSharpSource));
    }

    [Fact]
    public void PrimitiveNumericOverloads_ContinueReturningConcreteNumericTypes()
    {
        const string source = """
            package Issue2494.NumericControls
            import System
            import System.Linq

            let ints = []int32{7, -2, 11}
            Console.WriteLine(ints.Min())
            Console.WriteLine(ints.Max())

            let longs = []int64{int64(9), int64(-4), int64(12)}
            Console.WriteLine(longs.Min())
            Console.WriteLine(longs.Max())

            let doubles = []float64{3.5, -1.25, 8.0}
            Console.WriteLine(doubles.Min())
            Console.WriteLine(doubles.Max())

            let decimals = []decimal{3.5M, -1.25M, 8M}
            Console.WriteLine(decimals.Min())
            Console.WriteLine(decimals.Max())
            """;

        Assert.Equal(
            "-2\n11\n-4\n12\n-1.25\n8\n-1.25\n8\n",
            CompileAndRun(source));
    }

    [Fact]
    public void EnumErasure_DoesNotDistortNamedParamsOrConcreteGenericReceiverOverloads()
    {
        const string importedSource = """
            namespace Issue2494.ImportedOverloads;

            public static class ParamsProbe
            {
                public static int Pick(params int[] values) => values[0];
                public static T Pick<T>(params T[] values) => values[0];
            }

            public sealed class Box<T>
            {
                public string Pick(T value) => "typed";
                public string Pick(object value) => "object";
            }

            public static class NamedProbe
            {
                public static string Pick(int index, object value) => "named";
            }

            public static class ByRefProbe
            {
                public static int Read(ref int value) => value;
                public static T Read<T>(ref T value) => value;
            }

            public static class TupleProbe
            {
                public static int First((int, int) value) => value.Item1;
                public static T1 First<T1, T2>((T1, T2) value) => value.Item1;
            }
            """;
        const string source = """
            package Issue2494.OverloadControls
            import System
            import Issue2494.ImportedOverloads

            enum Choice2494 { Low, High }

            Console.WriteLine(
                ParamsProbe.Pick(Choice2494.Low, Choice2494.High) == Choice2494.Low)

            let box = Box[int32]()
            Console.WriteLine(box.Pick(Choice2494.Low))

            Console.WriteLine(NamedProbe.Pick(value: Choice2494.Low, index: 0))

            var choice = Choice2494.High
            Console.WriteLine(ByRefProbe.Read(ref choice) == Choice2494.High)

            let pair = (Choice2494.Low, 7)
            Console.WriteLine(TupleProbe.First(pair) == Choice2494.Low)
            """;

        Assert.Equal("True\nobject\nnamed\nTrue\nTrue\n", CompileAndRun(source, importedSource));
    }

    private static MethodInfo GetMethod(Type type, string name)
        => type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"Method '{name}' was not found on '{type}'.");

    private static string CompileAndRun(string source, string csharpSource = null)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2494_run_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(
                workDir,
                source,
                target: "exe",
                csharpSource);
            Assert.True(exitCode == 0, diagnostics);

            IlVerifier.Verify(outPath, additionalReferences: references);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec.");
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
            Assert.True(
                process.ExitCode == 0,
                $"dotnet exec failed ({process.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static Assembly CompileToAssembly(string source)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2494_reflection_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(
                workDir,
                source,
                target: "library",
                csharpSource: null);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outPath, additionalReferences: references);
            return Assembly.Load(File.ReadAllBytes(outPath));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (
        int ExitCode,
        string Diagnostics,
        string OutPath,
        string[] References) Compile(
        string workDir,
        string source,
        string target,
        string csharpSource)
    {
        var sourcePath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(sourcePath, source);

        var references = csharpSource == null
            ? Array.Empty<string>()
            : new[] { EmitCSharpLibrary(workDir, csharpSource) };

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references)
        {
            args.Add("/reference:" + reference);
        }

        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(args.ToArray());
            return (exitCode, stdout.ToString() + stderr, outPath, references);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string EmitCSharpLibrary(string workDir, string source)
    {
        var outputPath = Path.Combine(workDir, "Issue2494.Imported.dll");
        var syntaxTree = CSharpSyntaxTree.ParseText(source);
        var references = TrustedPlatformAssemblies()
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2494.Imported",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        Assert.False(string.IsNullOrWhiteSpace(value));
        return value!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
    }

    private static void TryDelete(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch
        {
        }
    }
}
