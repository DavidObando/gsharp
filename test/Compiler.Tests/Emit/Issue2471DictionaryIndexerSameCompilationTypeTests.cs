// <copyright file="Issue2471DictionaryIndexerSameCompilationTypeTests.cs" company="GSharp">
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
/// Issue #2471: a CLR indexer on an imported generic type closed over a
/// same-compilation source type must remain indexable. The original repro used
/// <c>Dictionary[Key, Value]</c>: ordinary methods such as <c>Add</c> bound,
/// but <c>cache[key] = value</c> reported GS0116.
/// </summary>
public class Issue2471DictionaryIndexerSameCompilationTypeTests
{
    private const string CustomIndexerCSharpSource = """
        using System;
        using System.Collections.Generic;

        namespace Issue2471.CSharp
        {
            public sealed class OverloadedBox<T>
            {
                private readonly Dictionary<int, T> values = new();

                public T this[int index]
                {
                    get => values[index];
                    set => values[index] = value;
                }

                public string this[string name] => "named:" + name;

                public void Put(int index, T value) => values[index] = value;
            }

            public sealed class RefBox<T>
            {
                private readonly T[] values = new T[1];

                public ref T this[int index] => ref values[index];

                public T Read(int index) => values[index];
            }

            public sealed class GenericKeyBox<T>
            {
                public string LastSetter { get; private set; } = "";

                public string this[T key]
                {
                    get => "generic";
                    set => LastSetter = "generic";
                }

                public string this[object key]
                {
                    get => "object";
                    set => LastSetter = "object";
                }
            }

            public sealed class ObjectKeyBox
            {
                public string this[object key] => key.GetType().Name;
            }

            public interface IMarker
            {
            }

            public sealed class InterfaceKeyBox
            {
                public string this[IMarker key] => "interface";

                public string this[object key] => "object";
            }

            public sealed class NestedKeyBox<T>
            {
                public string this[IEnumerable<T> keys] => "generic";

                public string this[List<object> keys] => "object";
            }

            public sealed class ArrayKeyBox<T>
            {
                public int this[T[] keys] => keys.Length;
            }

            public sealed class VarianceKeyBox
            {
                public string this[IEnumerable<object> keys] => "enumerable";

                public string this[object keys] => "object";
            }

        }
        """;

    [Fact]
    public void DictionaryOfSourceClasses_MethodsAndGetSetIndexers_CompileAndRun()
    {
        const string source = """
            package Issue2471.SourceClasses
            import System
            import System.Collections.Generic

            open data class Key2471(Id int32) {}
            open data class Value2471(Name string) {}

            func Put(cache Dictionary[Key2471, Value2471], key Key2471, value Value2471) {
                cache.Add(key, Value2471("method-bound"))
                cache[key] = value
            }

            let cache = Dictionary[Key2471, Value2471]()
            let key = Key2471(1)
            Put(cache, key, Value2471("indexer-bound"))
            Console.WriteLine(cache[key].Name)
            """;

        Assert.Equal("indexer-bound\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryOfSourceStructAndBclValue_GetSetIndexers_CompileAndRun()
    {
        const string source = """
            package Issue2471.SourceStruct
            import System
            import System.Collections.Generic

            struct StructKey2471(Id int32) {}

            let cache = Dictionary[StructKey2471, string]()
            let key = StructKey2471(7)
            cache.Add(key, "old")
            cache[key] = "new"
            Console.WriteLine(cache[key])
            """;

        Assert.Equal("new\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryOfSourceInterfaceAndBclStruct_GetSetIndexers_CompileAndRun()
    {
        const string source = """
            package Issue2471.SourceInterface
            import System
            import System.Collections.Generic

            interface IKey2471 {
                func Number() int32;
            }

            class InterfaceKey2471(NumberValue int32) : IKey2471 {
                func Number() int32 -> NumberValue
            }

            let key IKey2471 = InterfaceKey2471(3)
            let cache = Dictionary[IKey2471, Guid]()
            let replacement = Guid.Parse("01234567-89ab-cdef-0123-456789abcdef")
            cache.Add(key, Guid.Empty)
            cache[key] = replacement
            Console.WriteLine(cache[key].ToString())
            """;

        Assert.Equal("01234567-89ab-cdef-0123-456789abcdef\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryWithNestedImportedGenericValue_GetSetIndexers_CompileAndRun()
    {
        const string source = """
            package Issue2471.Nested
            import System
            import System.Collections.Generic

            open data class NestedKey2471(Id int32) {}
            open data class NestedValue2471(Name string) {}

            let key = NestedKey2471(1)
            let cache = Dictionary[NestedKey2471, List[NestedValue2471]]()
            cache.Add(key, List[NestedValue2471]())

            let replacement = List[NestedValue2471]()
            replacement.Add(NestedValue2471("nested"))
            cache[key] = replacement

            Console.WriteLine(cache[key][0].Name)
            """;

        Assert.Equal("nested\n", CompileAndRun(source));
    }

    [Fact]
    public void CompoundAssignment_EvaluatesReceiverIndexAndValueOnce()
    {
        const string source = """
            package Issue2471.SideEffects
            import System
            import System.Collections.Generic

            open data class CounterKey2471(Id int32) {}

            class Holder2471(Map Dictionary[CounterKey2471, int32]) {}

            let key = CounterKey2471(1)
            let cache = Dictionary[CounterKey2471, int32]()
            cache.Add(key, 10)
            let holder = Holder2471(cache)

            var receiverCalls = 0
            var indexCalls = 0
            var valueCalls = 0

            func GetHolder() Holder2471 {
                receiverCalls = receiverCalls + 1
                return holder
            }

            func GetKey() CounterKey2471 {
                indexCalls = indexCalls + 1
                return key
            }

            func GetValue() int32 {
                valueCalls = valueCalls + 1
                return 5
            }

            GetHolder().Map[GetKey()] += GetValue()
            Console.WriteLine(cache[key])
            Console.WriteLine(receiverCalls)
            Console.WriteLine(indexCalls)
            Console.WriteLine(valueCalls)
            """;

        Assert.Equal("15\n1\n1\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void CSharpGenericIndexer_OverloadSelection_CompilesAndRuns()
    {
        const string gsharpSource = """
            package Issue2471.CustomIndexers
            import System
            import Issue2471.CSharp

            open data class Payload2471(Name string) {}

            let overloaded = OverloadedBox[Payload2471]()
            overloaded.Put(0, Payload2471("method-bound"))
            overloaded[0] = Payload2471("setter-bound")
            Console.WriteLine(overloaded[0].Name)
            Console.WriteLine(overloaded["key"])
            """;

        Assert.Equal(
            "setter-bound\nnamed:key\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpGenericRefReturnIndexer_GetSet_CompilesAndRuns()
    {
        const string gsharpSource = """
            package Issue2471.RefReturnIndexer
            import System
            import Issue2471.CSharp

            open data class Payload2471(Name string) {}

            let byRef = RefBox[Payload2471]()
            byRef[0] = Payload2471("ref-bound")
            Console.WriteLine(byRef[0].Name)
            Console.WriteLine(byRef.Read(0).Name)
            """;

        Assert.Equal(
            "ref-bound\nref-bound\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpGenericIndexer_PrefersSymbolicTypeParameterOverObject()
    {
        const string gsharpSource = """
            package Issue2471.SymbolicOverload
            import System
            import Issue2471.CSharp

            open data class Payload2471(Name string) {}

            let key = Payload2471("key")
            let box = GenericKeyBox[Payload2471]()
            box[key] = "value"
            Console.WriteLine(box.LastSetter)
            Console.WriteLine(box[key])
            """;

        Assert.Equal(
            "generic\ngeneric\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpObjectIndexer_BoxesSourceStructIndex()
    {
        const string gsharpSource = """
            package Issue2471.ObjectIndexer
            import System
            import Issue2471.CSharp

            struct ObjectKey2471(Id int32) {}

            let key = ObjectKey2471(1)
            let box = ObjectKeyBox()
            Console.WriteLine(box[key])
            """;

        Assert.Equal(
            "ObjectKey2471\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpIndexer_PrefersImplementedInterfaceOverObject()
    {
        const string gsharpSource = """
            package Issue2471.InterfaceOverload
            import System
            import Issue2471.CSharp

            class Marker2471() : IMarker {}

            let key = Marker2471()
            let box = InterfaceKeyBox()
            Console.WriteLine(box[key])
            """;

        Assert.Equal(
            "interface\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpIndexer_UsesNestedSymbolicArgumentForOverloadResolution()
    {
        const string gsharpSource = """
            package Issue2471.NestedOverload
            import System
            import System.Collections.Generic
            import Issue2471.CSharp

            open data class Payload2471(Name string) {}

            let keys = List[Payload2471]()
            keys.Add(Payload2471("key"))
            let box = NestedKeyBox[Payload2471]()
            Console.WriteLine(box[keys])
            """;

        Assert.Equal(
            "generic\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpGenericArrayIndexer_SubstitutesSourceClassAndStructElements()
    {
        const string gsharpSource = """
            package Issue2471.ArrayIndexer
            import System
            import Issue2471.CSharp

            open data class ClassElement2471(Name string) {}
            struct StructElement2471(Id int32) {}

            let classItems = []ClassElement2471{ClassElement2471("a")}
            let structItems = []StructElement2471{StructElement2471(1), StructElement2471(2)}
            let classBox = ArrayKeyBox[ClassElement2471]()
            let structBox = ArrayKeyBox[StructElement2471]()
            Console.WriteLine(classBox[classItems])
            Console.WriteLine(structBox[structItems])
            """;

        Assert.Equal(
            "1\n2\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CSharpIndexer_DoesNotApplyGenericVarianceToSourceStruct()
    {
        const string gsharpSource = """
            package Issue2471.StructVariance
            import System
            import System.Collections.Generic
            import Issue2471.CSharp

            struct StructElement2471(Id int32) {}

            let keys = List[StructElement2471]()
            keys.Add(StructElement2471(1))
            let box = VarianceKeyBox()
            Console.WriteLine(box[keys])
            """;

        Assert.Equal(
            "object\n",
            CompileAndRun(gsharpSource, CustomIndexerCSharpSource));
    }

    [Fact]
    public void CompoundAssignment_InterpolatedIndexEvaluatesHolesOnce()
    {
        const string source = """
            package Issue2471.InterpolatedIndex
            import System
            import System.Collections.Generic

            let cache = Dictionary[string, int32]()
            cache.Add("key-1", 10)
            var calls = 0

            func Next() int32 {
                calls = calls + 1
                return calls
            }

            cache["key-${Next()}"] += 5
            Console.WriteLine(cache["key-1"])
            Console.WriteLine(calls)
            """;

        Assert.Equal("15\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void EmittedMethodMetadata_PreservesNestedSourceGenericArguments()
    {
        const string source = """
            package Issue2471.Metadata
            import System.Collections.Generic

            open data class MetadataKey2471(Id int32) {}
            open data class MetadataValue2471(Name string) {}

            class CacheApi2471 {
                func Put(
                    cache Dictionary[MetadataKey2471, List[MetadataValue2471]],
                    key MetadataKey2471,
                    values List[MetadataValue2471]) MetadataValue2471 {
                    cache[key] = values
                    return cache[key][0]
                }
            }
            """;

        var assembly = CompileToAssembly(source);
        var api = assembly.GetType("Issue2471.Metadata.CacheApi2471", throwOnError: true)!;
        var method = api.GetMethod(
            "Put",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!;
        var parameters = method.GetParameters();

        var dictionaryType = parameters[0].ParameterType;
        Assert.Equal(typeof(Dictionary<,>), dictionaryType.GetGenericTypeDefinition());

        var dictionaryArguments = dictionaryType.GetGenericArguments();
        Assert.Equal("MetadataKey2471", dictionaryArguments[0].Name);
        Assert.Equal(typeof(List<>), dictionaryArguments[1].GetGenericTypeDefinition());

        var valueType = dictionaryArguments[1].GetGenericArguments()[0];
        Assert.Equal("MetadataValue2471", valueType.Name);
        Assert.Equal(valueType, parameters[2].ParameterType.GetGenericArguments()[0]);
        Assert.Equal(valueType, method.ReturnType);
    }

    [Fact]
    public void AssignmentToTypeWithoutIndexer_StillReportsGS0116()
    {
        const string source = """
            package Issue2471.NotIndexable

            var value = 1
            value[0] = 2
            """;

        var (exitCode, diagnostics) = CompileExpectingFailure(source);

        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0116", diagnostics);
        Assert.Contains("not indexable", diagnostics);
    }

    private static string CompileAndRun(string source, string csharpSource = null)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2471_run_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(
                workDir,
                source,
                "exe",
                csharpSource);
            Assert.True(exitCode == 0, diagnostics);

            IlVerifier.Verify(outPath, additionalReferences: references);

            var runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
            if (!File.Exists(runtimeConfig))
            {
                File.WriteAllText(runtimeConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(runtimeConfig);
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
        var workDir = Directory.CreateTempSubdirectory("gs_issue2471_metadata_").FullName;
        try
        {
            var (exitCode, diagnostics, outPath, references) = Compile(
                workDir,
                source,
                "library",
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

    private static (int ExitCode, string Diagnostics) CompileExpectingFailure(string source)
    {
        var workDir = Directory.CreateTempSubdirectory("gs_issue2471_error_").FullName;
        try
        {
            var (exitCode, diagnostics, _, _) = Compile(
                workDir,
                source,
                "library",
                csharpSource: null);
            return (exitCode, diagnostics);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int ExitCode, string Diagnostics, string OutPath, string[] References) Compile(
        string workDir,
        string source,
        string target,
        string csharpSource)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

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

        args.Add(srcPath);

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
        var outputPath = Path.Combine(workDir, "Issue2471.CSharp.dll");
        var syntaxTree = CSharpSyntaxTree.ParseText(source);
        var references = TrustedPlatformAssemblies()
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2471.CSharp",
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
