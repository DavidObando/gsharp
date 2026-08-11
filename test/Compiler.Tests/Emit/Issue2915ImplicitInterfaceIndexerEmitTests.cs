// <copyright file="Issue2915ImplicitInterfaceIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issues #2915, #2954, #2960, and #3001: interface property accessors bind and emit
/// correctly for classes, structs, plain interfaces, and constructed interfaces.
/// </summary>
public class Issue2915ImplicitInterfaceIndexerEmitTests
{
    private const string IndexerMatrixSource = """
        package Issue2915Matrix
        import System

        interface IPlainClassGet {
            prop this[key string] int32 { get; }
        }

        class PlainClassGet : IPlainClassGet {
            prop this[key string] int32 -> key.Length + 8
        }

        interface IPlainClassSet {
            prop this[index int32] int32 { get; set; }
        }

        class PlainClassSet : IPlainClassSet {
            var Stored int32
            prop this[index int32] int32 {
                get { return Stored + index }
                set { Stored = value - index }
            }
        }

        interface IConstructedGet[T] {
            prop this[key string] T { get; }
        }

        class ConstructedGet : IConstructedGet[int32] {
            prop this[key string] int32 -> 17
        }

        class GenericGet[T] : IConstructedGet[T] {
            let Stored T
            init(value T) { Stored = value }
            prop this[key string] T -> Stored
        }

        interface IConstructedSet[T] {
            prop this[index int32] T { get; set; }
        }

        class ConstructedSet : IConstructedSet[int32] {
            var Stored int32
            prop this[index int32] int32 {
                get { return Stored + index }
                set { Stored = value - index }
            }
        }

        interface IPlainStructGet {
            prop this[index int32] int32 { get; }
        }

        struct PlainStructGet(Base int32) : IPlainStructGet {
            prop this[index int32] int32 -> Base + index
        }

        interface IPlainStructSet {
            prop this[index int32] int32 { get; set; }
        }

        struct PlainStructSet : IPlainStructSet {
            var Stored int32
            prop this[index int32] int32 {
                get { return Stored + index }
                set { Stored = value - index }
            }
        }

        interface IConstructedStructGet[T] {
            prop this[index int32] T { get; }
        }

        struct ConstructedStructGet(Base int32) : IConstructedStructGet[int32] {
            prop this[index int32] int32 -> Base + index
        }

        interface IConstructedStructSet[T] {
            prop this[index int32] T { get; set; }
        }

        struct ConstructedStructSet : IConstructedStructSet[int32] {
            var Stored int32
            prop this[index int32] int32 {
                get { return Stored + index }
                set { Stored = value - index }
            }
        }

        interface IExplicitPlain {
            prop this[index int32] int32 { get; }
        }

        class ExplicitPlain : IExplicitPlain {
            prop this[index int32] int32 -> 1
            private prop (IExplicitPlain) this[index int32] int32 -> 2
        }

        interface IExplicitConstructed[T] {
            prop this[index int32] T { get; }
        }

        class ExplicitConstructed : IExplicitConstructed[int32] {
            private prop (IExplicitConstructed[int32]) this[index int32] int32 -> 4
        }

        var plainClassGet IPlainClassGet = PlainClassGet()
        Console.WriteLine(plainClassGet["abc"])

        var plainClassSet IPlainClassSet = PlainClassSet()
        plainClassSet[2] = 42
        Console.WriteLine(plainClassSet[2])

        var constructedGet IConstructedGet[int32] = ConstructedGet()
        Console.WriteLine(constructedGet["value"])

        var constructedSet IConstructedSet[int32] = ConstructedSet()
        constructedSet[3] = 43
        Console.WriteLine(constructedSet[3])

        var genericGet IConstructedGet[int32] = GenericGet[int32](19)
        Console.WriteLine(genericGet["value"])

        var plainStructGet IPlainStructGet = PlainStructGet(30)
        Console.WriteLine(plainStructGet[5])

        var plainStructSet IPlainStructSet = PlainStructSet{}
        plainStructSet[4] = 44
        Console.WriteLine(plainStructSet[4])

        var constructedStructGet IConstructedStructGet[int32] = ConstructedStructGet(40)
        Console.WriteLine(constructedStructGet[6])

        var constructedStructSet IConstructedStructSet[int32] = ConstructedStructSet{}
        constructedStructSet[7] = 47
        Console.WriteLine(constructedStructSet[7])

        var explicitPlain = ExplicitPlain()
        var explicitPlainInterface IExplicitPlain = explicitPlain
        Console.WriteLine(explicitPlainInterface[0])
        Console.WriteLine(explicitPlain[0])

        var explicitConstructed IExplicitConstructed[int32] = ExplicitConstructed()
        Console.WriteLine(explicitConstructed[0])
        """;

    private static readonly string IndexerMatrixOutput =
        $"11{Environment.NewLine}42{Environment.NewLine}17{Environment.NewLine}43{Environment.NewLine}19{Environment.NewLine}35{Environment.NewLine}44{Environment.NewLine}46{Environment.NewLine}47{Environment.NewLine}2{Environment.NewLine}1{Environment.NewLine}4{Environment.NewLine}";

    [Fact]
    public void ChildHarness_ReportsKnownBadProgramAfterLoad()
    {
        const string source = """
            package Issue2915KnownBad
            import System

            throw InvalidOperationException("known bad control")
            """;

        var failure = Assert.ThrowsAny<XunitException>(
            () => CompileLoadAndRunChild("known_bad", source));
        Assert.Contains("known bad control", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ImplicitIndexers_LoadAndDispatchThroughInterfaceTypedReceivers()
    {
        Assert.Equal(
            Normalize(IndexerMatrixOutput),
            CompileLoadAndRunChild("indexer_matrix", IndexerMatrixSource));
    }

    [Fact]
    public void ImportedBasePlainIndexer_LoadsAndDispatchesThroughInterface()
    {
        const string source = """
            package Issue2915ImportedBase
            import System
            import System.Collections.Generic

            interface IStore {
                prop this[index int32] int32 { get; set; }
            }

            class Store : List[int32], IStore { }

            var store = Store()
            store.Add(7)
            var value IStore = store
            Console.WriteLine(value[0])
            value[0] = 9
            Console.WriteLine(value[0])
            """;

        Assert.Equal($"7{Environment.NewLine}9{Environment.NewLine}", CompileLoadAndRunChild("imported_base", source));
    }

    [Fact]
    public void ExplicitStructIndexer_LoadsAndDispatchesThroughInterface()
    {
        const string source = """
            package Issue2954ExplicitStruct
            import System

            interface IExplicit {
                prop this[key int32] int32 { get; }
            }

            struct ExplicitValue(Base int32) : IExplicit {
                private prop (IExplicit) this[key int32] int32 -> Base + key
            }

            var explicitValue IExplicit = ExplicitValue(5)
            Console.WriteLine(explicitValue[7])
            """;

        Assert.Equal($"12{Environment.NewLine}", CompileLoadAndRunChild("explicit_struct", source));
    }

    [Fact]
    public void NullableSequenceStructProperty_LoadsAndDispatchesThroughInterface()
    {
        const string source = """
            package Issue2960NullableSequence
            import System

            interface IBox {
                prop Vals sequence[int32?] { get; }
            }

            func values() sequence[int32?] {
                yield 5
                yield nil
            }

            struct Box : IBox {
                prop Vals sequence[int32?] -> values()
            }

            var box IBox = Box{}
            for value in box.Vals {
                Console.WriteLine(value == nil ? "nil" : value.ToString())
            }
            """;

        Assert.Equal($"5{Environment.NewLine}nil{Environment.NewLine}", CompileLoadAndRunChild("nullable_sequence", source));
    }

    [Fact]
    public void ComputedStructGetOnlyProperty_LoadsAndDispatchesThroughInterface()
    {
        const string source = """
            package Issue3001ComputedGetOnly
            import System

            interface ILabel {
                prop Label string { get; }
            }
            struct LabelValue : ILabel {
                prop Label string -> "hi"
            }

            var label ILabel = LabelValue{}
            Console.WriteLine(label.Label)
            """;

        Assert.Equal($"hi{Environment.NewLine}", CompileLoadAndRunChild("computed_get_only", source));
    }

    [Fact]
    public void ComputedStructGetSetProperty_LoadsAndDispatchesThroughInterface()
    {
        const string source = """
            package Issue3001ComputedGetSet
            import System

            interface ICounter {
                prop Value int32 { get; set; }
            }
            struct Counter : ICounter {
                var Stored int32
                prop Value int32 {
                    get { return Stored }
                    set { Stored = value }
                }
            }

            var counter ICounter = Counter{}
            counter.Value = 42
            Console.WriteLine(counter.Value)
            """;

        Assert.Equal($"42{Environment.NewLine}", CompileLoadAndRunChild("computed_get_set", source));
    }

    [Fact]
    public void AutoStructProperty_LoadsAndDispatchesThroughInterface()
    {
        const string source = """
            package Issue3001AutoProperty
            import System

            interface ICounter {
                prop Value int32 { get; set; }
            }
            struct Counter : ICounter {
                prop Value int32 { get; set; }
            }

            var counter ICounter = Counter{}
            counter.Value = 42
            Console.WriteLine(counter.Value)
            """;

        Assert.Equal($"42{Environment.NewLine}", CompileLoadAndRunChild("auto_property", source));
    }

    [Fact]
    public void MismatchedStructIndexer_StaysNonVirtual()
    {
        const string source = """
            package Issue2915MismatchedIndexer
            import System

            interface ITextIndexer {
                prop this[key string] int32 { get; }
            }
            struct MixedIndexer : ITextIndexer {
                prop this[key int32] int32 -> 1
                private prop (ITextIndexer) this[key string] int32 -> 2
            }

            var mixed = MixedIndexer{}
            var textIndexer ITextIndexer = mixed
            Console.WriteLine(textIndexer["key"])
            Console.WriteLine(mixed[0])
            """;

        Assert.Equal(
            $"2{Environment.NewLine}1{Environment.NewLine}",
            CompileLoadAndRunChild(
                "mismatched_indexer",
                source,
                assembly =>
                {
                    var type = assembly.GetType("Issue2915MismatchedIndexer.MixedIndexer");
                    var ordinaryGetter = type.GetMethod(
                        "get_Item",
                        BindingFlags.Public | BindingFlags.Instance,
                        binder: null,
                        types: new[] { typeof(int) },
                        modifiers: null);
                    Assert.NotNull(ordinaryGetter);
                    Assert.False(ordinaryGetter.IsVirtual);

                    var explicitGetter = type
                        .GetMethods(BindingFlags.NonPublic | BindingFlags.Instance)
                        .Single(method =>
                            method.Name.EndsWith(".get_Item", StringComparison.Ordinal)
                            && method.GetParameters() is [{ ParameterType: var parameterType }]
                            && parameterType == typeof(string));
                    Assert.True(explicitGetter.IsVirtual);
                }));
    }

    private static string CompileLoadAndRunChild(
        string tag,
        string source,
        Action<Assembly> inspectAssembly = null)
    {
        var directory = Directory.CreateTempSubdirectory($"gs_i2915_{tag}_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            var runtimeConfigPath = Path.Combine(directory, "test.runtimeconfig.json");
            File.WriteAllText(sourcePath, source);
            File.WriteAllText(
                runtimeConfigPath,
                """{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}""");

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var previousOutput = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOutput);
                Console.SetError(previousError);
            }

            if (exitCode != 0)
            {
                throw new XunitException(
                    "gsc failed:" + Environment.NewLine +
                    stdoutWriter + stderrWriter.ToString());
            }

            IlVerifier.Verify(assemblyPath);
            var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
            _ = assembly.GetTypes();
            inspectAssembly?.Invoke(assembly);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add(assemblyPath);

            using var process = Process.Start(startInfo)
                ?? throw new XunitException("Failed to start compiled child process.");
            var childOutputTask = process.StandardOutput.ReadToEndAsync();
            var childErrorTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(milliseconds: 30_000))
            {
                process.Kill(entireProcessTree: true);
                throw new XunitException("Compiled child process timed out.");
            }

            var childOutput = childOutputTask.GetAwaiter().GetResult();
            var childError = childErrorTask.GetAwaiter().GetResult();
            if (process.ExitCode != 0)
            {
                throw new XunitException(
                    $"Compiled child exited {process.ExitCode}:{Environment.NewLine}" +
                    childOutput + childError);
            }

            return Normalize(childOutput);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private static string Normalize(string value)
        => value.ReplaceLineEndings(Environment.NewLine);
}
