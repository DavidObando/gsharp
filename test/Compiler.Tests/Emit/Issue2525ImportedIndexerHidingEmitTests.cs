// <copyright file="Issue2525ImportedIndexerHidingEmitTests.cs" company="GSharp">
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
/// Issue #2525: imported indexers declared on a derived interface hide
/// same-signature indexers inherited from more distant interfaces.
/// </summary>
public sealed class Issue2525ImportedIndexerHidingEmitTests
{
    private const string ContractsSource = """
        #nullable enable
        using System;

        namespace Issue2525.Contracts
        {
            public interface IBase
            {
                string this[string key] { get; set; }
            }

            public interface IDerived : IBase
            {
                new string this[string key] { get; set; }
            }

            public sealed class SlotStore : IDerived
            {
                private string baseValue = "";
                private string derivedValue = "";

                string IBase.this[string key]
                {
                    get => "base:" + baseValue;
                    set => baseValue = value;
                }

                string IDerived.this[string key]
                {
                    get => "derived:" + derivedValue;
                    set => derivedValue = value;
                }
            }

            public interface IIntBase
            {
                int this[int index] { get; set; }
            }

            public interface IIntDerived : IIntBase
            {
                new int this[int index] { get; set; }
            }

            public sealed class IntStore : IIntDerived
            {
                private int baseValue;
                private int derivedValue;

                int IIntBase.this[int index]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                int IIntDerived.this[int index]
                {
                    get => derivedValue;
                    set => derivedValue = value;
                }
            }

            public interface IGenericBase<T>
            {
                T this[T key] { get; set; }
            }

            public interface IGenericDerived<T> : IGenericBase<T>
            {
                new T this[T key] { get; set; }
            }

            public sealed class GenericStore<T> : IGenericDerived<T>
            {
                private T baseValue = default!;
                private T derivedValue = default!;

                T IGenericBase<T>.this[T key]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                T IGenericDerived<T>.this[T key]
                {
                    get => derivedValue;
                    set => derivedValue = value;
                }
            }

            public interface IRoot
            {
                string this[string key] { get; set; }
            }

            public interface IMiddle : IRoot
            {
                new string this[string key] { get; set; }
            }

            public interface ILeaf : IMiddle
            {
                new string this[string key] { get; set; }
            }

            public sealed class MultiLevelStore : ILeaf
            {
                private string root = "";
                private string middle = "";
                private string leaf = "";

                string IRoot.this[string key]
                {
                    get => "root:" + root;
                    set => root = value;
                }

                string IMiddle.this[string key]
                {
                    get => "middle:" + middle;
                    set => middle = value;
                }

                string ILeaf.this[string key]
                {
                    get => "leaf:" + leaf;
                    set => leaf = value;
                }
            }

            public interface IDiamondRoot
            {
                string this[string key] { get; set; }
            }

            public interface IDiamondLeft : IDiamondRoot
            {
                new string this[string key] { get; set; }
            }

            public interface IDiamondRight : IDiamondRoot
            {
            }

            public interface IDiamondLeaf : IDiamondLeft, IDiamondRight
            {
                new string this[string key] { get; set; }
            }

            public sealed class DiamondStore : IDiamondLeaf
            {
                private string root = "";
                private string left = "";
                private string leaf = "";

                string IDiamondRoot.this[string key]
                {
                    get => "root:" + root;
                    set => root = value;
                }

                string IDiamondLeft.this[string key]
                {
                    get => "left:" + left;
                    set => left = value;
                }

                string IDiamondLeaf.this[string key]
                {
                    get => "diamond:" + leaf;
                    set => leaf = value;
                }
            }

            public interface IOverloadBase
            {
                string this[object key] { get; }
            }

            public interface IOverloadDerived : IOverloadBase
            {
                string this[string key] { get; }
            }

            public sealed class OverloadStore : IOverloadDerived
            {
                string IOverloadBase.this[object key] => "object";
                string IOverloadDerived.this[string key] => "string";
            }

            public interface IReturnBase
            {
                object this[string key] { get; }
            }

            public interface IReturnDerived : IReturnBase
            {
                new string this[string key] { get; }
            }

            public sealed class ReturnStore : IReturnDerived
            {
                object IReturnBase.this[string key] => new object();
                string IReturnDerived.this[string key] => "derived-return";
            }

            public interface IGetBase
            {
                int this[int index] { get; set; }
            }

            public interface IGetDerived : IGetBase
            {
                new int this[int index] { get; }
            }

            public sealed class GetStore : IGetDerived
            {
                private int baseValue;

                int IGetBase.this[int index]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                int IGetDerived.this[int index] => 25;
            }

            public interface ISetBase
            {
                int this[int index] { get; set; }
            }

            public interface ISetDerived : ISetBase
            {
                new int this[int index] { set; }
            }

            public sealed class SetStore : ISetDerived
            {
                private int baseValue;
                private int derivedValue;

                int ISetBase.this[int index]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                int ISetDerived.this[int index] { set => derivedValue = value; }

                public int DerivedValue => derivedValue;
            }

            public interface IRefBase
            {
                int this[int index] { get; set; }
            }

            public interface IRefDerived : IRefBase
            {
                new ref int this[int index] { get; }
            }

            public sealed class RefStore : IRefDerived
            {
                private int baseValue;
                private int derivedValue;

                int IRefBase.this[int index]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                ref int IRefDerived.this[int index] => ref derivedValue;
            }

            public interface IInitBase
            {
                string this[string key] { get; set; }
            }

            public interface IInitDerived : IInitBase
            {
                new string this[string key] { get; init; }
            }

            public sealed class InitStore : IInitDerived
            {
                private string baseValue = "";
                private string derivedValue = "";

                string IInitBase.this[string key]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                string IInitDerived.this[string key]
                {
                    get => derivedValue;
                    init => derivedValue = value;
                }

                public string DerivedValue => derivedValue;
            }

            public interface IOptionalBase
            {
                string this[string key, int suffix = 3] { get; }
            }

            public interface IOptionalDerived : IOptionalBase
            {
                new string this[string key, int suffix = 3] { get; }
            }

            public sealed class OptionalStore : IOptionalDerived
            {
                string IOptionalBase.this[string key, int suffix] => "base:" + suffix;
                string IOptionalDerived.this[string key, int suffix] => "derived:" + suffix;
            }

            public interface IOptionalGenericBase<T>
            {
                string this[T key, int suffix = 4] { get; }
            }

            public interface IOptionalGenericDerived<T> : IOptionalGenericBase<T>
            {
                new string this[T key, int suffix = 4] { get; }
            }

            public sealed class OptionalGenericStore<T> : IOptionalGenericDerived<T>
            {
                string IOptionalGenericBase<T>.this[T key, int suffix] => "base-generic:" + suffix;
                string IOptionalGenericDerived<T>.this[T key, int suffix] => "derived-generic:" + suffix;
            }

            public interface INullBase
            {
                string? this[string? key] { get; set; }
            }

            public interface INullDerived : INullBase
            {
                new string? this[string? key] { get; set; }
            }

            public sealed class NullStore : INullDerived
            {
                private string? baseValue;
                private string? derivedValue;

                string? INullBase.this[string? key]
                {
                    get => baseValue;
                    set => baseValue = value;
                }

                string? INullDerived.this[string? key]
                {
                    get => derivedValue;
                    set => derivedValue = value;
                }
            }

            public interface IAmbiguousA
            {
                string this[string key] { get; }
            }

            public interface IAmbiguousB
            {
                string this[string key] { get; }
            }

            public interface IAmbiguous : IAmbiguousA, IAmbiguousB
            {
            }

            public class ClassBase
            {
                public string this[string key] => "class-base";
            }

            public sealed class ClassDerived : ClassBase
            {
                public new string this[string key] => "class-derived";
            }

            public sealed class Holder
            {
                public IDerived Values { get; } = new SlotStore();
            }
        }
        """;

    [Fact]
    public void HiddenSlots_ReadWriteExpressionsGenericsDiamondAndClasses_RunVerifyReflectAndWorkFromCSharp()
    {
        const string source = """
            package Issue2525
            import System
            import Issue2525.Contracts

            open data class Payload2525(Name string) {}

            class Api {
                shared {
                    func Read(value IDerived) string -> value["key"]
                    func Write(value IDerived, text string) { value["key"] = text }
                    func ReadBase(value IBase) string -> value["key"]
                    func WriteBase(value IBase, text string) { value["key"] = text }
                    func Bump(value IIntDerived) int32 {
                        value[0] += 1
                        value[0]++
                        return value[0]
                    }
                }
            }

            func Main() {
                let slots = SlotStore()
                let derived IDerived = slots
                Api.Write(derived, "gsharp")
                Console.WriteLine(Api.Read(derived))
                let asBase IBase = derived
                Api.WriteBase(asBase, "base")
                Console.WriteLine(Api.ReadBase(asBase))

                let ints = IntStore()
                let intDerived IIntDerived = ints
                intDerived[0] = 10
                intDerived[0] += 4
                intDerived[0]++
                Console.WriteLine(intDerived[0])
                let maybe IIntDerived? = intDerived
                Console.WriteLine(maybe?[0])
                let intBase IIntBase = intDerived
                intBase[0] = 2
                Console.WriteLine(intBase[0])

                let generic = GenericStore[Payload2525]()
                let genericDerived IGenericDerived[Payload2525] = generic
                let derivedKey = Payload2525("derived-key")
                genericDerived[derivedKey] = Payload2525("generic-derived")
                Console.WriteLine(genericDerived[derivedKey].Name)
                let genericBase IGenericBase[Payload2525] = genericDerived
                let baseKey = Payload2525("base-key")
                genericBase[baseKey] = Payload2525("generic-base")
                Console.WriteLine(genericBase[baseKey].Name)

                let multi = MultiLevelStore()
                let leaf ILeaf = multi
                leaf["key"] = "value"
                Console.WriteLine(leaf["key"])
                let root IRoot = leaf
                root["key"] = "value"
                Console.WriteLine(root["key"])

                let diamond IDiamondLeaf = DiamondStore()
                diamond["key"] = "value"
                Console.WriteLine(diamond["key"])

                let overloaded IOverloadDerived = OverloadStore()
                Console.WriteLine(overloaded["key"])
                let boxed object = "key"
                Console.WriteLine(overloaded[boxed])

                let changed IReturnDerived = ReturnStore()
                Console.WriteLine(changed["key"].Length)

                let getOnly IGetDerived = GetStore()
                Console.WriteLine(getOnly[0])

                let setStore = SetStore()
                let setOnly ISetDerived = setStore
                setOnly[0] = 2525
                Console.WriteLine(setStore.DerivedValue)

                let byRef IRefDerived = RefStore()
                byRef[0] = 8
                byRef[0]++
                Console.WriteLine(byRef[0])

                let initStore = InitStore()
                let initLike IInitDerived = initStore
                initLike["key"] = "init"
                Console.WriteLine(initStore.DerivedValue)

                let optional IOptionalDerived = OptionalStore()
                Console.WriteLine(optional["key"])

                let optionalGeneric IOptionalGenericDerived[Payload2525] = OptionalGenericStore[Payload2525]()
                Console.WriteLine(optionalGeneric[Payload2525("key")])

                let nullable INullDerived = NullStore()
                nullable["nullable-key"] = "nullable-value"
                let nullableResult string? = nullable["nullable-key"]
                Console.WriteLine(nullableResult)

                let classDerived = ClassDerived()
                Console.WriteLine(classDerived["key"])
                let classBase ClassBase = classDerived
                Console.WriteLine(classBase["key"])

                let holder = Holder{Values: {["nested"] = "write"}}
                Console.WriteLine(holder.Values["nested"])
            }
            """;

        using var result = Compile(source, "exe");
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { result.ContractsPath });
        Assert.Equal(
            """
            derived:gsharp
            base:base
            15
            15
            2
            generic-derived
            generic-base
            leaf:value
            root:value
            diamond:value
            string
            object
            14
            25
            2525
            9
            init
            derived:3
            derived-generic:4
            nullable-value
            class-derived
            class-base
            derived:write
            """.Replace("\r\n", "\n", StringComparison.Ordinal) + "\n",
            Run(result.OutputPath));

        var contracts = Assembly.LoadFrom(result.ContractsPath);
        var derivedType = contracts.GetType("Issue2525.Contracts.IDerived", throwOnError: true)!;
        var baseType = contracts.GetType("Issue2525.Contracts.IBase", throwOnError: true)!;
        var derivedProperty = derivedType.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Single();
        var baseProperty = baseType.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Single();
        Assert.NotEqual(baseProperty.MetadataToken, derivedProperty.MetadataToken);

        var emitted = Assembly.LoadFrom(result.OutputPath);
        var api = emitted.GetType("Issue2525.Api", throwOnError: true)!;
        Assert.Equal("Issue2525.Contracts.IDerived", api.GetMethod("Read")!.GetParameters()[0].ParameterType.FullName);
        Assert.Equal("Issue2525.Contracts.IBase", api.GetMethod("ReadBase")!.GetParameters()[0].ParameterType.FullName);

        var consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, result.ContractsPath);
        IlVerifier.Verify(consumerPath, additionalReferences: new[] { result.OutputPath, result.ContractsPath });
        Assert.Equal(
            "derived:consumer\nbase:consumer-base\n4\n",
            Run(consumerPath));
    }

    [Theory]
    [InlineData("func Bad(value IGetDerived) { value[0] = 1 }")]
    [InlineData("func Bad(value ISetDerived) int32 -> value[0]")]
    [InlineData("func Bad(value IAmbiguous) string -> value[\"key\"]")]
    public void HiddenAccessorAvailabilityAndUnrelatedAmbiguity_ReportGS0116(string declaration)
    {
        var source = $$"""
            package Issue2525.Errors
            import Issue2525.Contracts

            {{declaration}}
            """;

        using var result = Compile(source, "library", expectSuccess: false);
        Assert.Contains("GS0116", result.Diagnostics, StringComparison.Ordinal);
        Assert.Contains("not indexable", result.Diagnostics, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UnrelatedBaseIndexers_AreAlsoAmbiguousInCSharp()
    {
        const string consumer = """
            using Issue2525.Contracts;

            public static class Consumer
            {
                public static string Read(IAmbiguous value) => value["key"];
            }
            """;

        using var result = Compile("package Issue2525.Empty", "library");
        var compilation = CreateCSharpCompilation(
            "Issue2525.AmbiguousConsumer",
            consumer,
            OutputKind.DynamicallyLinkedLibrary,
            result.ContractsPath);
        Assert.Contains(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error
                && (diagnostic.Id == "CS0121" || diagnostic.Id == "CS0229"));
    }

    [Fact]
    public void AspNetHeaderDictionary_StringValuesReadWriteShape_CompilesRunsAndIlVerifies()
    {
        var aspNetReferences = GetAspNetReferences();
        if (aspNetReferences.Length == 0)
        {
            return;
        }

        const string source = """
            package Issue2525.Headers
            import Microsoft.AspNetCore.Http

            class HeaderApi {
                shared {
                    func Read(headers IHeaderDictionary) string -> headers["Authorization"].ToString()
                    func Write(headers IHeaderDictionary) { headers["Retry-After"] = "1" }
                }
            }
            """;

        using var result = Compile(
            source,
            "library",
            additionalReferences: aspNetReferences,
            emitContracts: false,
            outputFileName: "Issue2525.Headers.dll");
        IlVerifier.Verify(result.OutputPath, additionalReferences: aspNetReferences);

        var consumerPath = EmitHeaderConsumer(
            result.DirectoryPath,
            result.OutputPath,
            aspNetReferences);
        IlVerifier.Verify(
            consumerPath,
            additionalReferences: aspNetReferences.Concat(new[] { result.OutputPath }).ToArray());
        Assert.Equal("Bearer token\n1\n", Run(consumerPath, includeAspNetCore: true));
    }

    private static CompilationResult Compile(
        string source,
        string target,
        bool expectSuccess = true,
        IReadOnlyList<string> additionalReferences = null,
        bool emitContracts = true,
        string outputFileName = "Issue2525.dll")
    {
        var directory = NewDirectory();
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, outputFileName);
        File.WriteAllText(sourcePath, source);

        var contractsPath = emitContracts
            ? EmitCSharpAssembly(directory, "Issue2525.Contracts", ContractsSource)
            : null;
        var references = new List<string>();
        if (contractsPath != null)
        {
            references.Add(contractsPath);
        }

        if (additionalReferences != null)
        {
            references.AddRange(additionalReferences);
        }

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        args.AddRange(references.Select(reference => "/reference:" + reference));
        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        var diagnostics = stdout.ToString() + stderr;
        if (expectSuccess)
        {
            Assert.True(exitCode == 0, diagnostics);
        }
        else
        {
            Assert.NotEqual(0, exitCode);
        }

        return new CompilationResult(directory, outputPath, contractsPath, diagnostics);
    }

    private static string EmitCSharpAssembly(string directory, string assemblyName, string source)
    {
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        var compilation = CreateCSharpCompilation(
            assemblyName,
            source,
            OutputKind.DynamicallyLinkedLibrary);
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static CSharpCompilation CreateCSharpCompilation(
        string assemblyName,
        string source,
        OutputKind outputKind,
        params string[] additionalReferences)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Concat(additionalReferences.Select(path => MetadataReference.CreateFromFile(path)));
        return CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(outputKind, nullableContextOptions: NullableContextOptions.Enable));
    }

    private static string EmitCSharpConsumer(
        string directory,
        string gsharpAssembly,
        string contractsAssembly)
    {
        const string source = """
            using System;
            using Issue2525;
            using Issue2525.Contracts;

            internal static class Program
            {
                private static void Main()
                {
                    var store = new SlotStore();
                    IDerived derived = store;
                    Api.Write(derived, "consumer");
                    Console.WriteLine(Api.Read(derived));
                    Api.WriteBase(derived, "consumer-base");
                    Console.WriteLine(Api.ReadBase(derived));

                    IIntDerived ints = new IntStore();
                    ints[0] = 2;
                    Console.WriteLine(Api.Bump(ints));
                }
            }
            """;
        var outputPath = Path.Combine(directory, "consumer.dll");
        var compilation = CreateCSharpCompilation(
            "Issue2525.Consumer",
            source,
            OutputKind.ConsoleApplication,
            gsharpAssembly,
            contractsAssembly);
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string EmitHeaderConsumer(
        string directory,
        string gsharpAssembly,
        IReadOnlyList<string> aspNetReferences)
    {
        const string source = """
            using System;
            using Issue2525.Headers;
            using Microsoft.AspNetCore.Http;

            internal static class Program
            {
                private static void Main()
                {
                    IHeaderDictionary headers = new HeaderDictionary();
                    headers.Authorization = "Bearer token";
                    HeaderApi.Write(headers);
                    Console.WriteLine(HeaderApi.Read(headers));
                    Console.WriteLine(headers["Retry-After"].ToString());
                }
            }
            """;
        var outputPath = Path.Combine(directory, "header-consumer.dll");
        var references = aspNetReferences.Concat(new[] { gsharpAssembly }).ToArray();
        var compilation = CreateCSharpCompilation(
            "Issue2525.HeaderConsumer",
            source,
            OutputKind.ConsoleApplication,
            references);
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string Run(string assemblyPath, bool includeAspNetCore = false)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        var frameworks = includeAspNetCore
            ? """
                "frameworks": [
                  { "name": "Microsoft.NETCore.App", "version": "10.0.0" },
                  { "name": "Microsoft.AspNetCore.App", "version": "10.0.0" }
                ]
              """
            : """
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              """;
        File.WriteAllText(
            runtimeConfigPath,
            $$"""
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                {{frameworks}}
              }
            }
            """);

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exec failed ({process.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    private static string[] GetAspNetReferences()
    {
        var coreDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var sharedDirectory = Directory.GetParent(coreDirectory!)?.Parent?.FullName;
        var aspNetRoot = sharedDirectory == null
            ? null
            : Path.Combine(sharedDirectory, "Microsoft.AspNetCore.App");
        if (aspNetRoot == null || !Directory.Exists(aspNetRoot))
        {
            return Array.Empty<string>();
        }

        var coreVersion = Path.GetFileName(coreDirectory);
        var versionDirectory = Path.Combine(aspNetRoot, coreVersion);
        if (!Directory.Exists(versionDirectory))
        {
            versionDirectory = Directory.GetDirectories(aspNetRoot)
                .OrderByDescending(path => path, StringComparer.Ordinal)
                .FirstOrDefault();
        }

        return versionDirectory == null
            ? Array.Empty<string>()
            : Directory.GetFiles(versionDirectory, "*.dll");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        Assert.False(string.IsNullOrWhiteSpace(value));
        return value!.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
    }

    private static string NewDirectory()
    {
        var path = Path.Combine(
            AppContext.BaseDirectory,
            "issue2525",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(
            string directoryPath,
            string outputPath,
            string contractsPath,
            string diagnostics)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
            ContractsPath = contractsPath;
            Diagnostics = diagnostics;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public string ContractsPath { get; }

        public string Diagnostics { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
            }
        }
    }
}
