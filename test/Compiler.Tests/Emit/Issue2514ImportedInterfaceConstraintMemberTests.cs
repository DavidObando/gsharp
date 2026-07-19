// <copyright file="Issue2514ImportedInterfaceConstraintMemberTests.cs" company="GSharp">
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
/// Issue #2514: imported interface constraints expose their complete accessible
/// instance contract through type-parameter receivers.
/// </summary>
public sealed class Issue2514ImportedInterfaceConstraintMemberTests
{
    private const string ContractsSource = """
        using System;

        namespace Issue2514.Contracts
        {
            public interface IBase<T>
            {
                T Value { get; set; }
                T this[int index] { get; set; }
                event EventHandler Changed;
                event Action<T> ItemChanged;
                T Echo(T value);
                string ReadOnly { get; }
                string WriteOnly { set; }
            }

            public interface IContract<T> : IBase<T>
            {
                string Name { get; set; }
                string Echo(string prefix, int value);
            }

            public interface ISelf<T> where T : ISelf<T>
            {
                T Next { get; }
            }

            public interface IStaticContract
            {
                static abstract int Code { get; }
            }

            public sealed class RefContract : IContract<string>
            {
                private readonly string[] values = new string[4];
                private string name = "Ada";
                private string contractValue = "seed";

                public string Value
                {
                    get => contractValue;
                    set
                    {
                        contractValue = value;
                        ItemChanged?.Invoke(value);
                    }
                }
                public string ReadOnly => "read-only";
                public string WriteOnly { set => Value = value; }
                public string Name
                {
                    get => name;
                    set
                    {
                        name = value;
                        Changed?.Invoke(this, EventArgs.Empty);
                    }
                }

                public string this[int index]
                {
                    get => values[index] ?? "";
                    set => values[index] = value;
                }

                public event EventHandler? Changed;
                public event Action<string>? ItemChanged;
                public string Echo(string value) => value + "!";
                public string Echo(string prefix, int value) => prefix + value;
            }

            public struct ValueContract : IContract<int>
            {
                private int value;

                public int Value { readonly get => value; set => this.value = value; }
                public readonly string ReadOnly => "value";
                public string WriteOnly { set => this.value = value.Length; }
                public string Name { readonly get => "struct"; set { } }
                public int this[int index]
                {
                    readonly get => value + index;
                    set => this.value = value - index;
                }

                public event EventHandler? Changed;
                public event Action<int>? ItemChanged;
                public readonly int Echo(int value) => value + 1;
                public readonly string Echo(string prefix, int value) => prefix + value;
            }

            public sealed class Node : ISelf<Node>
            {
                public int Id => 2514;
                public Node Next => this;
            }

            public sealed class StaticContract : IStaticContract
            {
                public static int Code => 2514;
            }
        }
        """;

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(
        () => TrustedPlatformAssemblies().ToArray());

    [Fact]
    public void ImportedConstraintMembers_RunVerifyReflectAndWorkFromCSharp()
    {
        const string source = """
            package Issue2514
            import System
            import Issue2514.Contracts

            class Api {
                shared {
                    func ReadName[T IContract[string]](value T) string -> value.Name
                    func WriteName[T IContract[string]](value T, name string) { value.Name = name }
                    func ReadValue[T IContract[string]](value T) string -> value.Value
                    func WriteValue[T IContract[string]](value T, text string) { value.Value = text }
                    func ReadIndex[T IContract[string]](value T, index int32) string -> value[index]
                    func WriteIndex[T IContract[string]](value T, index int32, text string) string {
                        value[index] = text
                        return value[index]
                    }
                    func Echo[T IContract[string]](value T, text string) string -> value.Echo(text)
                    func EchoNumber[T IContract[string]](value T, number int32) string -> value.Echo("number:", number)
                    func ReadNext[T ISelf[T]](value T) T -> value.Next
                    func SubscribeAndWrite[T IContract[string]](value T, name string, handler EventHandler) {
                        value.Changed += handler
                        value.Name = name
                        value.Changed -= handler
                    }
                    func SubscribeItem[T IContract[string]](value T, handler Action[string]) {
                        value.ItemChanged += handler
                        value.Value = "item"
                        value.ItemChanged -= handler
                    }
                    func Make[T IContract[string] init()]() T -> T{Name: "made", Value: "created"}
                    func StructRoundtrip[T IContract[int32]](value T) int32 {
                        value.Value = 40
                        value[2] = 50
                        return value.Value + value[2] + value.Echo(1)
                    }
                }
            }

            func Main() {
                var person = RefContract()
                Console.WriteLine(Api.ReadName(person))
                Api.WriteName(person, "Grace")
                Console.WriteLine(Api.ReadName(person))
                Api.WriteValue(person, "value")
                Console.WriteLine(Api.ReadValue(person))
                Console.WriteLine(Api.WriteIndex(person, 1, "indexed"))
                Console.WriteLine(Api.Echo(person, "echo"))
                Console.WriteLine(Api.EchoNumber(person, 7))
                Console.WriteLine(Api.ReadNext(Node()).Id)
                Console.WriteLine(Api.StructRoundtrip(ValueContract()))
                var made = Api.Make[RefContract]()
                Console.WriteLine(made.Name + ":" + made.Value)
            }
            """;

        using var result = Compile(source, "exe");
        Assert.Equal(
            "Ada\nGrace\nvalue\nindexed\necho!\nnumber:7\n2514\n100\nmade:created\n",
            Run(result.OutputPath));
        IlVerifier.Verify(result.OutputPath, additionalReferences: new[] { result.ContractsPath });

        var assembly = Assembly.LoadFrom(result.OutputPath);
        var api = assembly.GetType("Issue2514.Api")!;
        var readNameParameter = api.GetMethod("ReadName")!.GetGenericArguments().Single();
        Assert.Contains(
            readNameParameter.GetGenericParameterConstraints(),
            constraint => constraint.IsGenericType
                && constraint.GetGenericTypeDefinition().FullName == "Issue2514.Contracts.IContract`1"
                && constraint.GetGenericArguments()[0] == typeof(string));

        var makeParameter = api.GetMethod("Make")!.GetGenericArguments().Single();
        Assert.True(
            (makeParameter.GenericParameterAttributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0);

        var consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, result.ContractsPath);
        Assert.Equal(
            "CSharp\nconsumer\nconsumer!\nnumber:8\n2514\n100\nmade:created\n1\nitem\n",
            Run(consumerPath));
    }

    [Theory]
    [InlineData(
        "func Bad[T IContract[string]](value T) string -> value.Missing",
        "GS0158")]
    [InlineData(
        "func Bad[T IContract[string]](value T) { value.ReadOnly = \"x\" }",
        "GS0127")]
    [InlineData(
        "func Bad[T IContract[string]](value T) string -> value.WriteOnly",
        "GS0127")]
    [InlineData(
        "func Bad[T IStaticContract]() int32 -> T.Code",
        "GS0333")]
    [InlineData(
        "func Bad(value Node) string -> ReadName[Node](value)",
        "GS0152")]
    public void InvalidConstraintMemberUsesRetainSpecificDiagnostics(string member, string diagnosticId)
    {
        var source = $$"""
            package Issue2514Negative
            import Issue2514.Contracts

            func ReadName[T IContract[string]](value T) string -> value.Name
            {{member}}
            """;

        using var result = Compile(source, "library", expectSuccess: false);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal);
    }

    [Fact]
    public void SiblingGSharpInterfaceConstraint_PropertiesBindAndRun()
    {
        const string contracts = """
            package Issue2514.Sibling

            interface ISourceContract {
                prop Name string { get; set; }
            }

            class SourcePerson : ISourceContract {
                prop Name string { get; set; }
                init() { Name = "source" }
            }
            """;
        const string consumer = """
            package Issue2514.SiblingConsumer
            import System
            import Issue2514.Sibling

            func Read[T ISourceContract](value T) string -> value.Name
            func Write[T ISourceContract](value T, name string) { value.Name = name }

            func Main() {
                var person = SourcePerson()
                Console.WriteLine(Read(person))
                Write(person, "sibling")
                Console.WriteLine(Read(person))
            }
            """;

        var directory = CreateArtifactDirectory();
        try
        {
            var contractsPath = CompileGSharpFile(
                directory,
                "contracts.gs",
                contracts,
                "Issue2514.Sibling.dll",
                "library");
            var consumerPath = CompileGSharpFile(
                directory,
                "consumer.gs",
                consumer,
                "consumer.dll",
                "exe",
                contractsPath);
            IlVerifier.Verify(consumerPath, additionalReferences: new[] { contractsPath });
            Assert.Equal("source\nsibling\n", Run(consumerPath));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static CompilationResult Compile(string source, string target, bool expectSuccess = true)
    {
        var directory = CreateArtifactDirectory();
        var contractsPath = EmitContracts(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var outputPath = Path.Combine(directory, "Issue2514.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/reference:" + contractsPath,
            "/nowarn:GS9100",
        };
        args.AddRange(BclReferences.Value.Select(reference => "/reference:" + reference));
        args.Add(sourcePath);

        var execution = RunCompiler(args);
        if (expectSuccess)
        {
            Assert.True(
                execution.ExitCode == 0,
                $"compile failed ({execution.ExitCode})\nstdout:\n{execution.Stdout}\nstderr:\n{execution.Stderr}");
        }

        return new CompilationResult(
            directory,
            outputPath,
            contractsPath,
            execution.ExitCode,
            execution.Stdout,
            execution.Stderr);
    }

    private static string CompileGSharpFile(
        string directory,
        string fileName,
        string source,
        string outputName,
        string target,
        params string[] references)
    {
        var sourcePath = Path.Combine(directory, fileName);
        var outputPath = Path.Combine(directory, outputName);
        File.WriteAllText(sourcePath, source);
        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        args.AddRange(references.Select(reference => "/reference:" + reference));
        args.AddRange(BclReferences.Value.Select(reference => "/reference:" + reference));
        args.Add(sourcePath);
        var result = RunCompiler(args);
        Assert.True(
            result.ExitCode == 0,
            $"compile failed ({result.ExitCode})\nstdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        return outputPath;
    }

    private static (int ExitCode, string Stdout, string Stderr) RunCompiler(List<string> args)
    {
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

        return (exitCode, stdout.ToString(), stderr.ToString());
    }

    private static string EmitContracts(string directory)
    {
        var outputPath = Path.Combine(directory, "Issue2514.Contracts.dll");
        var syntaxTree = CSharpSyntaxTree.ParseText(
            ContractsSource,
            new CSharpParseOptions(LanguageVersion.Latest));
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2514.Contracts",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return outputPath;
    }

    private static string EmitCSharpConsumer(
        string directory,
        string gsharpAssembly,
        string contractsAssembly)
    {
        const string source = """
            using System;
            using Issue2514;
            using Issue2514.Contracts;

            internal static class Program
            {
                private static void Main()
                {
                    var person = new RefContract();
                    Api.WriteName(person, "CSharp");
                    Console.WriteLine(Api.ReadName(person));
                    Console.WriteLine(Api.WriteIndex(person, 0, "consumer"));
                    Console.WriteLine(Api.Echo(person, "consumer"));
                    Console.WriteLine(Api.EchoNumber(person, 8));
                    Console.WriteLine(Api.ReadNext(new Node()).Id);
                    Console.WriteLine(Api.StructRoundtrip(new ValueContract()));
                    var made = Api.Make<RefContract>();
                    Console.WriteLine(made.Name + ":" + made.Value);
                    var count = 0;
                    EventHandler handler = (_, _) => count++;
                    Api.SubscribeAndWrite(person, "event", handler);
                    Console.WriteLine(count);
                    string? item = null;
                    Action<string> itemHandler = value => item = value;
                    Api.SubscribeItem(person, itemHandler);
                    Console.WriteLine(item);
                }
            }
            """;
        var outputPath = Path.Combine(directory, "consumer.dll");
        var syntaxTree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Concat(new[]
            {
                MetadataReference.CreateFromFile(gsharpAssembly),
                MetadataReference.CreateFromFile(contractsAssembly),
            });
        var compilation = CSharpCompilation.Create(
            "Issue2514.Consumer",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        File.Copy(
            Path.ChangeExtension(gsharpAssembly, ".runtimeconfig.json"),
            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
            overwrite: true);
        return outputPath;
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator);
    }

    private static string CreateArtifactDirectory()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2514-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void DeleteDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
        }
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(
            string directoryPath,
            string outputPath,
            string contractsPath,
            int exitCode,
            string stdout,
            string stderr)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
            ContractsPath = contractsPath;
            ExitCode = exitCode;
            Stdout = stdout;
            Stderr = stderr;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public string ContractsPath { get; }

        public int ExitCode { get; }

        public string Stdout { get; }

        public string Stderr { get; }

        public void Dispose() => DeleteDirectory(DirectoryPath);
    }
}
