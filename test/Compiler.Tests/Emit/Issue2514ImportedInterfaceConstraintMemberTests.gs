// <copyright file="Issue2514ImportedInterfaceConstraintMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2514: imported interface constraints expose their complete accessible
/// instance contract through type-parameter receivers.
class Issue2514ImportedInterfaceConstraintMemberTests {
    @Fact
    func ImportedConstraintMembers_RunVerifyReflectAndWorkFromCSharp() {
        const source = `package Issue2514
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
}`
        using let result = Compile(source, "exe")
        Assert.Equal(
            "Ada${Environment.NewLine}Grace${Environment.NewLine}value${Environment.NewLine}indexed${Environment.NewLine}echo!${Environment.NewLine}number:7${Environment.NewLine}2514${Environment.NewLine}100${Environment.NewLine}made:created${Environment.NewLine}",
            Run(result.OutputPath)
        )
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{result.ContractsPath})
        let assembly = EmittedFixture.Load(result.OutputPath)
        let api = assembly.GetType("Issue2514.Api")!!
        let readNameParameter = api.GetMethod("ReadName")!!.GetGenericArguments().Single()
        Assert.Contains(
            readNameParameter.GetGenericParameterConstraints(),
            (constraint Type) -> constraint.IsGenericType && constraint.GetGenericTypeDefinition()
                .FullName == "Issue2514.Contracts.IContract`1" &&
                constraint.GetGenericArguments()[0] == typeof(string)
        )
        let makeParameter = api.GetMethod("Make")!!.GetGenericArguments().Single()
        Assert.True(
            (makeParameter.GenericParameterAttributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0
        )
        let consumerPath = EmitCSharpConsumer(result.DirectoryPath, result.OutputPath, result.ContractsPath)
        Assert.Equal(
            "CSharp${Environment.NewLine}consumer${Environment.NewLine}consumer!${Environment.NewLine}number:8${Environment.NewLine}2514${Environment.NewLine}100${Environment.NewLine}made:created${Environment.NewLine}1${Environment.NewLine}item${Environment.NewLine}",
            Run(consumerPath)
        )
    }

    @Fact
    func ConstrainedObjectInitializer_WithSpilledSetterValue_RunsAndVerifies() {
        const source = `package Issue2741
import System
import System.Collections.Generic
import Issue2514.Contracts

func Next(value string) string -> value + "!"

func Add[T IContract[string] class init()](items ICollection[T], names IEnumerable[string]) {
    for name in names {
        var item = T{Name: Next(name)}
        items.Add(item)
    }
}

func Main() {
    var items = List[RefContract]()
    var names = List[string]()
    names.Add("Ada")
    names.Add("Grace")
    Add[RefContract](items, names)
    Console.WriteLine(items[0].Name)
    Console.WriteLine(items[1].Name)
}`
        using let result = Compile(source, "exe")
        Assert.Equal("Ada!${Environment.NewLine}Grace!${Environment.NewLine}", Run(result.OutputPath))
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{result.ContractsPath})
    }

    @Fact
    func OrdinaryInterfaceReceiver_WithSpilledSetterValue_RunsAndVerifies() {
        const source = `package Issue2741Control
import System
import Issue2514.Contracts

func Next(value string) string -> value + "!"
func SetName(value IContract[string], name string) { value.Name = Next(name) }

func Main() {
    var value = RefContract()
    SetName(value, "ordinary")
    Console.WriteLine(value.Name)
}`
        using let result = Compile(source, "exe")
        Assert.Equal("ordinary!${Environment.NewLine}", Run(result.OutputPath))
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{result.ContractsPath})
    }

    @Fact
    func ConstrainedObjectInitializer_WithAwaitedSetterValue_RunsAndVerifies() {
        const source = `package Issue2741Async
import System
import System.Threading.Tasks
import Issue2514.Contracts

async func Make[T IContract[string] class init()](name string) T {
    var pending = Task.FromResult[string](name + "!")
    return T{Name: await pending}
}

func Main() {
    var value = Make[RefContract]("async").Result
    Console.WriteLine(value.Name)
}`
        using let result = Compile(source, "exe")
        Assert.Equal("async!${Environment.NewLine}", Run(result.OutputPath))
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{result.ContractsPath})
    }

    @Theory
    @InlineData("func Bad[T IContract[string]](value T) string -> value.Missing", "GS0158")
    @InlineData("func Bad[T IContract[string]](value T) { value.ReadOnly = \"x\" }", "GS0127")
    @InlineData("func Bad[T IContract[string]](value T) string -> value.WriteOnly", "GS0127")
    @InlineData("func Bad[T IStaticContract]() int32 -> T.Code", "GS0333")
    @InlineData("func Bad(value Node) string -> ReadName[Node](value)", "GS0152")
    func InvalidConstraintMemberUsesRetainSpecificDiagnostics(member string, diagnosticId string) {
        let source = (`package Issue2514Negative
import Issue2514.Contracts

func ReadName[T IContract[string]](value T) string -> value.Name
` + "$member")
        using let result = Compile(source, "library", expectSuccess: false)
        Assert.NotEqual(0, result.ExitCode)
        Assert.Contains(diagnosticId, result.Stdout + result.Stderr, StringComparison.Ordinal)
    }

    @Fact
    func SiblingGSharpInterfaceConstraint_PropertiesBindAndRun() {
        const contracts = `package Issue2514.Sibling

interface ISourceContract {
    prop Name string { get; set; }
}

class SourcePerson : ISourceContract {
    prop Name string { get; set; }
    init() { Name = "source" }
}`
        const consumer = `package Issue2514.SiblingConsumer
import System
import Issue2514.Sibling

func Read[T ISourceContract](value T) string -> value.Name
func Write[T ISourceContract](value T, name string) { value.Name = name }

func Main() {
    var person = SourcePerson()
    Console.WriteLine(Read(person))
    Write(person, "sibling")
    Console.WriteLine(Read(person))
}`
        let directory = CreateArtifactDirectory()
        try {
            let contractsPath = CompileGSharpFile(
                directory,
                "contracts.gs",
                contracts,
                "Issue2514.Sibling.dll",
                "library"
            )
            let consumerPath = CompileGSharpFile(
                directory,
                "consumer.gs",
                consumer,
                "consumer.dll",
                "exe",
                contractsPath
            )
            IlVerifier.Verify(consumerPath, additionalReferences: []string{contractsPath})
            Assert.Equal("source${Environment.NewLine}sibling${Environment.NewLine}", Run(consumerPath))
        } finally {
            DeleteDirectory(directory)
        }
    }

    private class CompilationResult : IDisposable {
        init(
            directoryPath string,
            outputPath string,
            contractsPath string,
            exitCode int32,
            stdout string,
            stderr string
        ) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
            ContractsPath = contractsPath
            ExitCode = exitCode
            Stdout = stdout
            Stderr = stderr
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        prop ContractsPath string {
            get;
        }

        prop ExitCode int32 {
            get;
        }

        prop Stdout string {
            get;
        }

        prop Stderr string {
            get;
        }

        func Dispose() -> Issue2514ImportedInterfaceConstraintMemberTests.DeleteDirectory(DirectoryPath)
    }

    shared {
        // Issue #3705 family 2: `#nullable enable` is load-bearing, not tidying.
        // This fixture is about member REACHABILITY through an imported interface
        // constraint, and the G# side assigns every read to a non-null `string`. In
        // an oblivious compilation those members carry no `[Nullable]` metadata, and
        // per #1354 / ADR-0136 gsc imports an unannotated reference position as
        // `T?` — so the assignments were only legal while the constrained-receiver
        // readers still dropped declaration nullability. Annotating the fixture
        // states the contract the test always meant (these members really are
        // non-null) instead of relying on that gap. The `EventHandler?` /
        // `Action<T>?` declarations below were already written in nullable style.
        private const ContractsSource string = `#nullable enable
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
}`

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                return TrustedPlatformAssemblies().ToArray()
            }
        )

        private func Compile(
            source string,
            target string,
            expectSuccess bool = true
        ) Issue2514ImportedInterfaceConstraintMemberTests
            .CompilationResult {
            let directory = CreateArtifactDirectory()
            let contractsPath = EmitContracts(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "Issue2514.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/reference:" + contractsPath,
                "/nowarn:GS9100"
            }
            args.AddRange(BclReferences.Value.Select((reference string) -> ("/reference:" + reference)))
            args.Add(sourcePath)
            let execution = RunCompiler(args)
            if expectSuccess {
                Assert.True(execution.ExitCode == 0, (`compile failed (` + "${execution.ExitCode}" + `)
stdout:
` + "${execution.Stdout}" + `
stderr:
` + "${execution.Stderr}"))
            }
            return Issue2514ImportedInterfaceConstraintMemberTests.CompilationResult(
                directory,
                outputPath,
                contractsPath,
                execution.ExitCode,
                execution.Stdout,
                execution.Stderr
            )
        }

        private func CompileGSharpFile(
            directory string,
            fileName string,
            source string,
            outputName string,
            target string,
            references ...string
        ) string {
            let sourcePath = Path.Combine(directory, fileName)
            let outputPath = Path.Combine(directory, outputName)
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            args.AddRange(references.Select((reference string) -> ("/reference:" + reference)))
            args.AddRange(BclReferences.Value.Select((reference string) -> ("/reference:" + reference)))
            args.Add(sourcePath)
            let result = RunCompiler(args)
            Assert.True(result.ExitCode == 0, (`compile failed (` + "${result.ExitCode}" + `)
stdout:
` + "${result.Stdout}" + `
stderr:
` + "${result.Stderr}"))
            return outputPath
        }

        private func RunCompiler(args List[string])(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, stdout.ToString(), stderr.ToString())
        }

        private func EmitContracts(directory string) string {
            let outputPath = Path.Combine(directory, "Issue2514.Contracts.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(ContractsSource, CSharpParseOptions(LanguageVersion.Latest))
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Issue2514.Contracts",
                []SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func EmitCSharpConsumer(directory string, gsharpAssembly string, contractsAssembly string) string {
            const source = `using System;
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
}`
            let outputPath = Path.Combine(directory, "consumer.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .Concat(
                []PortableExecutableReference{
                    MetadataReference.CreateFromFile(gsharpAssembly),
                    MetadataReference.CreateFromFile(contractsAssembly)
                }
            )
            let compilation = CSharpCompilation.Create(
                "Issue2514.Consumer",
                []SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.ConsoleApplication)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            File.Copy(
                Path.ChangeExtension(gsharpAssembly, ".runtimeconfig.json"),
                Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                overwrite: true
            )
            return outputPath
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(value) {
                Enumerable.Empty[string]()
            } else {
                cast[IEnumerable[string]](value!!.Split(Path.PathSeparator))
            }
        }

        private func CreateArtifactDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2514-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}
