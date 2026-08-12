// <copyright file="Issue3354RectangularArrayEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Emit, ILVerify, runtime, async, and metadata coverage for issue #3354.</summary>
public class Issue3354RectangularArrayEmitTests
{
    [Fact]
    public void HighestSupportedRank_EmitsVerifiesAndRuns()
    {
        var dimensions = string.Join(", ", Enumerable.Repeat("0", 32));
        var source = $"""
            package P
            import System
            let value = [{dimensions}]int32
            Console.WriteLine(value.Rank)
            Console.WriteLine(value.Length)
            """;

        Assert.Equal($"32{Environment.NewLine}0{Environment.NewLine}", CompileVerifyAndRun(source));
    }

    [Fact]
    public void NativeArrays_Rank2Rank3InitializersMembersForeachStructGenericsAndCovariance_Run()
    {
        const string Source = """
            package P
            import System
            import System.Collections.Generic
            import Gsharp.Extensions.Go

            struct Cell { var Value int32 }
            class RefCell { var Value int32 }
            class Holder { var Grid [,]int32 = [2, 3]int32{1, 2, 3, 4, 5, 6} }
            class EmptyHolder { var Grid [,]int32 }
            class GenericHolder[T] {
                var Values [,]T
                func Count() int32 { return Values.Length }
            }
            class BareHolder {
                var Field [,]int32 = [1, 1]int32
                prop Data [,]int32 { get; set; }
                init() { Data = [1, 1]int32 }
                func Fill() {
                    Field[0, 0] = 10
                    Data[0, 0] = 20
                }
            }
            func Echo[T](value [,]T) [,]T { return value }
            func GenericReadWrite[T](value [,]T, replacement T) T {
                value[0, 0] = replacement
                return value[0, 0]
            }
            func MakeGrid[T](value T) [,]T { return [1, 1]T{value} }
            func BoxGrid[T](value [,]T) List[[,]T] {
                let values = List[[,]T]()
                values.Add(value)
                return values
            }
            func CountItems[T](value [,]T) int32 {
                var count = 0
                for item in value { count++ }
                return count
            }
            func Set(value [,]int32, row int32, column int32, item int32) {
                value[row, column] = item
            }
            func SetAddress(ref value int32) { value = 12 }
            func WriteThroughAddress(value [,]int32) int32 {
                SetAddress(ref value[0, 0])
                return value[0, 0]
            }
            func ReadThroughClosure(value [,]int32) int32 {
                let read = () -> value[0, 0]
                return read()
            }
            func YieldGrid(value [,]int32) sequence[int32] {
                yield value[0, 0]
                yield value[0, 1]
            }
            func ArrayLength(value Array) int32 { return value.Length }
            func Maybe(flag bool) [,]?int32 {
                if flag { return [1, 2]int32{3, 4} }
                return nil
            }

            let holder = Holder()
            Console.WriteLine(holder.Grid[1, 2])
            Set(holder.Grid, 0, 1, 9)
            let returned = Echo[int32](holder.Grid)
            Console.WriteLine(returned[0, 1])
            let wideRow int64 = 1
            Console.WriteLine(returned[wideRow, 2])
            Console.WriteLine(returned.Length)
            Console.WriteLine(returned.Rank)
            Console.WriteLine(returned.GetLength(1))
            Console.WriteLine(returned.GetLowerBound(0))
            Console.WriteLine(returned.GetUpperBound(1))
            Console.WriteLine(len(returned))
            let empty = EmptyHolder().Grid
            Console.WriteLine(empty.Rank)
            Console.WriteLine(empty.Length)
            Console.WriteLine(GenericHolder[string]().Count())
            let bare = BareHolder()
            bare.Fill()
            Console.WriteLine(bare.Field[0, 0] + bare.Data[0, 0])
            var sum = 0
            for item in returned { sum += item }
            Console.WriteLine(sum)
            var keyed = 0
            for index, item in returned { keyed += index * 10 + item }
            Console.WriteLine(keyed)
            var cells = [1, 1]Cell
            cells[0, 0].Value = 42
            Console.WriteLine(cells[0, 0].Value)
            var cellSum = 0
            for cell in cells { cellSum += cell.Value }
            Console.WriteLine(cellSum)
            let refCells = [1, 1]RefCell{RefCell()}
            refCells[0, 0].Value = 5
            for refCell in refCells { Console.WriteLine(refCell.Value) }
            Console.WriteLine(ArrayLength(cells))
            let cube = [1, 2, 2]string
            cube[0, 1, 1] = "rank3"
            Console.WriteLine(cube[0, 1, 1])
            let generic = Echo[string]([1, 1]string{"generic"})
            Console.WriteLine(generic[0, 0])
            let nullableElements = [1, 2]string?{nil, "value"}
            Console.WriteLine(nullableElements[0, 0] == nil)
            Console.WriteLine(nullableElements[0, 1])
            let nested = [1, 1][]int32{[]int32{7}}
            Console.WriteLine(nested[0, 0][0])
            var maybe [,]?string = nil
            Console.WriteLine(maybe == nil)
            Console.WriteLine(Maybe(false)?[0, 1] == nil)
            Console.WriteLine(Maybe(true)?[0, 1]!!)
            let strings = [1, 1]string{"text"}
            Console.WriteLine(CountItems[string](strings))
            Console.WriteLine(GenericReadWrite[string]([1, 1]string{"old"}, "generic-write"))
            Console.WriteLine(MakeGrid[string]("made")[0, 0])
            Console.WriteLine(BoxGrid[string]([1, 1]string{"boxed"})[0][0, 0])
            Console.WriteLine(WriteThroughAddress([1, 1]int32))
            Console.WriteLine(ReadThroughClosure([1, 1]int32{13}))
            var yielded = 0
            for item in YieldGrid([1, 2]int32{2, 3}) { yielded = yielded * 10 + item }
            Console.WriteLine(yielded)
            var objects [,]object = strings
            try {
                objects[0, 0] = Object()
            } catch (ex ArrayTypeMismatchException) {
                Console.WriteLine(ex.GetType().Name)
            }
            """;
        var expected = string.Join(
            Environment.NewLine,
            "6",
            "9",
            "6",
            "6",
            "2",
            "3",
            "0",
            "2",
            "6",
            "2",
            "0",
            "0",
            "30",
            "28",
            "178",
            "42",
            "42",
            "5",
            "1",
            "rank3",
            "generic",
            "True",
            "value",
            "7",
            "True",
            "True",
            "4",
            "1",
            "generic-write",
            "made",
            "boxed",
            "12",
            "13",
            "23",
            "ArrayTypeMismatchException",
            string.Empty);

        Assert.Equal(expected, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void EvaluationOrderMultiAssignmentAndClrExceptions_ArePreserved()
    {
        const string Source = """
            package P
            import System
            func Mark(label string, value int32) int32 {
                log += label
                return value
            }
            func Target() [,]int32 {
                log += "T"
                return grid
            }
            func Value(label string, value int32) int32 {
                log += label
                return value
            }
            func MutateFirstIndex() int32 {
                firstIndex = 1
                return 0
            }
            func SwapSelected() int32 {
                selected = replacement
                return 0
            }
            func CoalesceValue() string {
                coalesceIndex = 1
                return "set"
            }

            var log = ""
            var grid = [2, 2]int32
            var firstIndex = 0
            var selected = [1, 1]int32
            var original = selected
            var replacement = [1, 1]int32
            var coalesceIndex = 0
            var nullableGrid = [1, 1]string?
            Target()[Mark("R", 0), Mark("C", 1)] += Value("V", 5)
            Console.WriteLine(log)
            Console.WriteLine(grid[0, 1])
            log = ""
            Target()[Mark("R", 0), Mark("C", 0)] = Value("V", 6)
            Console.WriteLine(log)
            Console.WriteLine(grid[0, 0])
            log = ""
            let previous = grid[0, 0]++
            Console.WriteLine(previous)
            Console.WriteLine(grid[0, 0])
            grid[firstIndex, MutateFirstIndex()] = 8
            Console.WriteLine(grid[0, 0] * 10 + grid[1, 0])
            selected[SwapSelected(), 0] = 4
            Console.WriteLine(original[0, 0] * 10 + replacement[0, 0])
            nullableGrid[coalesceIndex, 0] ??= CoalesceValue()
            Console.WriteLine(nullableGrid[0, 0])
            grid[Mark("A", 0), Mark("B", 0)], grid[Mark("C", 1), Mark("D", 1)] = Value("E", 7), Value("F", 9)
            Console.WriteLine(log)
            Console.WriteLine(grid[0, 0] * 10 + grid[1, 1])
            log = ""
            let sized = [Mark("X", 2), Mark("Y", 3)]int32
            Console.WriteLine(log)
            Console.WriteLine(sized.Length)
            try {
                let negative = [-1, 2]int32
            } catch (ex Exception) {
                Console.WriteLine(ex.GetType().Name)
            }
            try {
                Console.WriteLine(sized[0, 3])
            } catch (ex Exception) {
                Console.WriteLine(ex.GetType().Name)
            }
            """;
        var expected = string.Join(
            Environment.NewLine,
            "TRCV",
            "5",
            "TRCV",
            "6",
            "6",
            "7",
            "80",
            "40",
            "set",
            "ABCDEF",
            "79",
            "XY",
            "6",
            "OverflowException",
            "IndexOutOfRangeException",
            string.Empty);

        Assert.Equal(expected, CompileVerifyAndRun(Source));
    }

    [Fact]
    public void AwaitedDimensionsIndicesWritesReadsAndInitializers_SpillOnceLeftToRight()
    {
        const string Source = """
            package P
            import System
            import System.Threading.Tasks
            var calls = 0
            var dimensionBeforeAwait = 2
            var indexBeforeAwait = 0
            var selected = [1, 1]int32
            var original = selected
            var replacement = [1, 1]int32
            async func Id(value int32) Task[int32] {
                await Task.Yield()
                calls++
                return value
            }
            async func MutateDimension() Task[int32] {
                await Task.Yield()
                dimensionBeforeAwait = 4
                return 1
            }
            async func MutateIndex() Task[int32] {
                await Task.Yield()
                indexBeforeAwait = 1
                return 0
            }
            async func SwapTarget() Task[int32] {
                await Task.Yield()
                selected = replacement
                return 0
            }
            async func Run() Task[int32] {
                let sized = [await Id(2), await Id(3)]int32
                sized[await Id(0), await Id(1)] = 42
                let initialized = [1, 2]int32{await Id(4), await Id(5)}
                let stable = [dimensionBeforeAwait, await MutateDimension()]int32
                stable[indexBeforeAwait, await MutateIndex()] = 7
                selected[await SwapTarget(), 0] = 9
                return sized[await Id(0), await Id(1)] + initialized[0, 0] + initialized[0, 1]
                    + stable[0, 0] + original[0, 0] + stable.Length * 100
            }
            Console.WriteLine(Run().GetAwaiter().GetResult())
            Console.WriteLine(calls)
            """;

        Assert.Equal($"267{Environment.NewLine}8{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void ExpressionTrees_SupportRectangularAllocationAndIndexRead()
    {
        const string Source = """
            package P
            import System
            import System.Linq.Expressions
            let read Expression[Func[[,]int32, int32]] = (value [,]int32) -> value[1, 0]
            let make Expression[Func[[,]int32]] = () -> [2, 3]int32
            let value = [2, 2]int32
            value[1, 0] = 42
            Console.WriteLine(read.Compile()(value))
            let made = make.Compile()()
            Console.WriteLine(made.Rank)
            Console.WriteLine(made.Length)
            """;

        Assert.Equal($"42{Environment.NewLine}2{Environment.NewLine}6{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    [Fact]
    public void ImportedClrFieldsPropertiesParametersReturnsAndGenericArrays_RoundTrip()
    {
        const string Contract = """
            #nullable enable
            namespace MdContracts;
            public static class MdApi
            {
                public static int[,] Field = new int[,] { { 1, 2 }, { 3, 4 } };
                public static int[,,] Cube { get; set; } = new int[1, 2, 2];
                public static int[,] Echo(int[,] value) => value;
                public static T[,] Generic<T>(T value) => new T[,] { { value } };
                public static T[,] Identity<T>(T[,] value) => value;
                public static int Sum(int[,] value) => value[0, 0] + value[0, 1] + value[1, 0] + value[1, 1];
                public static int ArrayRank(System.Array value) => value.Rank;
                public static string?[,]? Maybe { get; set; }
            }
            """;
        const string Source = """
            package P
            import System
            import MdContracts
            struct LocalCell { var Value int32 }
            func Echo(value [,]int32) [,]int32 { return MdApi.Echo(value) }
            let field = MdApi.Field
            Console.WriteLine(field[1, 0])
            field[0, 1] = 8
            Console.WriteLine(MdApi.Sum(field))
            Console.WriteLine(Echo(field)[0, 1])
            MdApi.Cube[0, 1, 1] = 9
            Console.WriteLine(MdApi.Cube[0, 1, 1])
            let generic = MdApi.Generic[string]("ok")
            Console.WriteLine(generic[0, 0])
            let localCells = [1, 1]LocalCell
            Console.WriteLine(MdApi.ArrayRank(localCells))
            Console.WriteLine(MdApi.Identity(localCells).Rank)
            Console.WriteLine(localCells.GetLength(0))
            Console.WriteLine(MdApi.Maybe == nil)
            MdApi.Maybe = [1, 1]string?{nil}
            Console.WriteLine(MdApi.Maybe!![0, 0] == nil)
            """;

        Assert.Equal(
            $"3{Environment.NewLine}16{Environment.NewLine}8{Environment.NewLine}9{Environment.NewLine}ok{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}1{Environment.NewLine}True{Environment.NewLine}True{Environment.NewLine}",
            CompileVerifyAndRun(Source, Contract));
    }

    [Fact]
    public void ExportedRectangularSignatures_AreConsumableByRoslynAndReflection()
    {
        const string Source = """
            package Exported
            public class MdApi {
                shared {
                    public var Field [,]int32 = [1, 2]int32{3, 4}
                    public func Echo(value [,,]string) [,,]string { return value }
                    public func Generic[T](value [,]T) [,]T { return value }
                    public func Maybe(value [,]?string?) [,]?string? { return value }
                }
            }
            """;
        const string Consumer = """
            using Exported;
            public static class Consumer
            {
                public static int Read() => MdApi.Field[0, 1];
                public static string[,,] Echo(string[,,] value) => MdApi.Echo(value);
                public static int[,] Generic(int[,] value) => MdApi.Generic<int>(value);
                public static string?[,]? Maybe(string?[,]? value) => MdApi.Maybe(value);
            }
            """;
        var directory = CreateCaseDirectory();
        try
        {
            var libraryPath = CompileGSharp(directory, Source, target: "library");
            IlVerifier.Verify(libraryPath);
            var consumerPath = CompileCSharpContract(directory, Consumer, "Issue3354.Consumer", libraryPath);

            var library = AssemblyLoadContext.Default.LoadFromAssemblyPath(libraryPath);
            var api = library.GetType("Exported.MdApi", throwOnError: true);
            var field = api.GetField("Field", BindingFlags.Public | BindingFlags.Static);
            var array = Assert.IsAssignableFrom<Array>(field.GetValue(null));
            Assert.Equal(2, array.Rank);
            Assert.Equal(4, array.GetValue(0, 1));
            var nullableInfo = new NullabilityInfoContext().Create(api.GetMethod("Maybe").ReturnParameter);
            Assert.Equal(NullabilityState.Nullable, nullableInfo.ReadState);
            Assert.Equal(NullabilityState.Nullable, nullableInfo.ElementType.ReadState);

            var consumer = AssemblyLoadContext.Default.LoadFromAssemblyPath(consumerPath);
            Assert.Equal(4, consumer.GetType("Consumer", throwOnError: true).GetMethod("Read").Invoke(null, null));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileVerifyAndRun(string source, string contractSource = null)
    {
        var directory = CreateCaseDirectory();
        try
        {
            string contractPath = null;
            if (contractSource != null)
            {
                contractPath = CompileCSharpContract(directory, contractSource, "Issue3354.Contract");
            }

            var outputPath = CompileGSharp(directory, source, target: "exe", contractPath);
            IlVerifier.Verify(outputPath, contractPath == null ? null : new[] { contractPath });

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
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}:{Environment.NewLine}{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static string CompileGSharp(
        string directory,
        string source,
        string target,
        string referencePath = null)
    {
        var sourcePath = Path.Combine(directory, "Program.gs");
        var outputPath = Path.Combine(directory, "Issue3354." + target + ".dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        if (referencePath != null)
        {
            arguments.Add("/reference:" + referencePath);
            arguments.AddRange(ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => "/reference:" + path));
        }

        arguments.Add(sourcePath);
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
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

        Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{stdout}{stderr}");
        return outputPath;
    }

    private static string CompileCSharpContract(
        string directory,
        string source,
        string assemblyName,
        string additionalReference = null)
    {
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToList();
        if (additionalReference != null)
        {
            references.Add(MetadataReference.CreateFromFile(additionalReference));
        }

        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        var path = Path.Combine(directory, assemblyName + ".dll");
        using var stream = File.Create(path);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }

    private static string CreateCaseDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3354RectangularArrayEmitTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
