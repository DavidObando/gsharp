package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import System.Text.Json
import System.Text.RegularExpressions
import Xunit

class Issue5389InheritedImportedPropertyDriverTests {
    @Fact
    func QualifiedWrites_DispatchAccessorsAndEvaluateReceiverAndValueOnce() {
        Check(`interface IView : IValue {
    func Write() { this.Value = 4 }
    func Add() { this.Value += 4 }
}
class Trace {
    shared {
        func Target(value IView) IView {
            System.Console.Write("R")
            return value
        }
        func Next() int32 {
            System.Console.Write("A")
            return 3
        }
        func Store(value IView) {
            value.Value = Next()
            value.Value += Next()
            Target(value).Value = Next()
            Target(value).Value += Next()
        }
        func Postfix(value IView) int32 { return Target(value).Value++ }
        func Prefix(value IView) int32 { return ++Target(value).Value }
    }
}
`, `public interface IView : IValue {
    void Write() { this.Value = 4; }
    void Add() { this.Value += 4; }
}
public class Trace {
    static IView Target(IView value) { Console.Write("R"); return value; }
    static int Next() { Console.Write("A"); return 3; }
    public static void Store(IView value) {
        value.Value = Next();
        value.Value += Next();
        Target(value).Value = Next();
        Target(value).Value += Next();
    }
    public static int Postfix(IView value) { return Target(value).Value++; }
    public static int Prefix(IView value) { return ++Target(value).Value; }
}
`, `class Item : ValueStore, IView {}
class Program {
    static void Main() {
        var item = new Item();
        IView view = item;
        view.Write(); view.Add(); Trace.Store(view);
        Console.Write(Trace.Postfix(view)); Console.Write(Trace.Prefix(view));
        Console.Write($"|{item.Raw}:{item.Reads}:{item.Writes}");
    }
}`, "S4GS8AS3GAS6RAS3RGAS6RGS76RGS88|8:5:8")
    }

    @Fact
    func GenericInheritedProperties_RetainOpenClosedAndSourceArguments() {
        Check(`interface Forward[T] : IForward[T] {}
interface IView[T] : Forward[T] {
    func Write(value T) { this.Value = value }
    func Read() T { return this.Value }
}
interface Closed : Forward[int32] {
    func Add() { this.Value += 4 }
}
class Payload { func Mark() { System.Console.Write("P") } }
interface Source : Forward[Payload] {
    func Write(value Payload) { this.Value = value }
    func Read() Payload { return this.Value }
}
`, `public interface Forward<T> : IForward<T> {}
public interface IView<T> : Forward<T> {
    void Write(T value) { this.Value = value; }
    T Read() { return this.Value; }
}
public interface Closed : Forward<int> {
    void Add() { this.Value += 4; }
}
public class Payload { public void Mark() { Console.Write("P"); } }
public interface Source : Forward<Payload> {
    void Write(Payload value) { this.Value = value; }
    Payload Read() { return this.Value; }
}
`, `class Text : ValueStore<string>, IView<string> {}
class Number : ValueStore<int>, Closed {}
class Local : ValueStore<Payload>, Source {}
class Program {
    static void Main() {
        var text = new Text();
        IView<string> open = text;
        open.Write("hello"); Console.Write(open.Read());
        Console.Write($"|{text.Reads}:{text.Writes}|");
        var number = new Number();
        ((Closed)number).Add();
        Console.Write($"{number.Raw}:{number.Reads}:{number.Writes}|");
        var local = new Local();
        Source source = local;
        source.Write(new Payload()); source.Read().Mark();
        Console.Write($"|{local.Reads}:{local.Writes}");
    }
}`, "SGhello|1:1|GS4:1:1|SGP|1:1")
    }

    @Fact
    func BareAndSourceProperties_PreserveHidingAndRejectInvalidAccessorsAndValues() {
        Check(`class Outer {
    shared {
        var Value int32 = 90
        func Read() int32 { return Value }
    }
    interface Nested : IValue {
        func Write() { Value = 6 }
        func Add() { Value += 3 }
    }
}
interface Own : IValue {
    prop Value int32 { get; set }
    func Write() { Value = 11 }
    func Add() { this.Value += 2 }
}
`, `public class Outer {
    public static int Value = 90;
    public static int Read() { return Value; }
    public interface Nested : IValue {
        void Write() { Value = 6; }
        void Add() { Value += 3; }
    }
}
public interface Own : IValue {
    new int Value { get; set; }
    void Write() { Value = 11; }
    void Add() { this.Value += 2; }
}
`, `class NestedItem : ValueStore, Outer.Nested {}
class OwnItem : ValueStore, Own {
    int own;
    int Own.Value {
        get { Console.Write("H"); return own; }
        set { Console.Write("W" + value); own = value; }
    }
    public int OwnRaw => own;
}
class Program {
    static void Main() {
        var nested = new NestedItem();
        Outer.Nested view = nested;
        view.Write(); view.Add();
        Console.Write($"|{nested.Raw}:{nested.Reads}:{nested.Writes}:{Outer.Read()}|");
        var own = new OwnItem();
        ((Own)own).Write(); ((Own)own).Add();
        Console.Write($"|{own.OwnRaw}:{own.Raw}:{own.Reads}:{own.Writes}");
    }
}`, "S6GS9|9:1:2:90|W11HW13|13:0:0:0")
        for operation in[]string{
            "this.ReadOnly = 4",
            "this.ReadOnly += 4",
            "this.Locked = 4",
            "this.Locked += 4",
            "this.WriteOnly += 4"
        } {
            Reject(
                "interface Rejected : IRestricted {\n    func Fail() { " + operation + " }\n}\n",
                "GS0127",
                if operation.StartsWith("this.WriteOnly", StringComparison.Ordinal) {
                    "2,34,2,36"
                } else if operation.StartsWith("this.ReadOnly", StringComparison.Ordinal) {
                    if operation.Contains("+=") {
                        "2,33,2,35"
                    } else {
                        "2,33,2,34"
                    }
                } else {
                    if operation.Contains("+=") {
                        "2,31,2,33"
                    } else {
                        "2,31,2,32"
                    }
                }
            )
        }
        Reject("interface Rejected : IValue {\n    func Fail() { this.Value = \"bad\" }\n}\n", "GS0155", "2,32,2,37")
        Reject(
            "interface Rejected : IValue {\n    prop Value int32 { get }\n    func Fail() { this.Value = 4 }\n}\n",
            "GS0127",
            "3,30,3,31"
        )
        Reject("interface Rejected : IValue {\n    func Fail() { this.Missing = 4 }\n}\n", "GS0158", "2,24,2,31")
    }

    @Fact
    func ImportedSignatures_PreserveNullablePlatformAndSetterOnlyContracts() {
        Check(`interface Optional : IOptional[string] {
    func Clear() { this.Value = nil }
    func Write(value string?) { this.Value = value }
    func Read() string? { return this.Value }
}
interface Oblivious : IOblivious {
    func Clear() { this.Value = nil }
}
interface Writer : IRestricted {
    func Write() { this.WriteOnly = 7 }
}
`, `public interface Optional : IOptional<string> {
    void Clear() { this.Value = null; }
    void Write(string? value) { this.Value = value; }
    string? Read() { return this.Value; }
}
public interface Oblivious : IOblivious {
    void Clear() { this.Value = null; }
}
public interface Writer : IRestricted {
    void Write() { this.WriteOnly = 7; }
}
`, `class OptionalItem : OptionalStore, Optional {}
class ObliviousItem : ObliviousStore, Oblivious {}
class WriterItem : Writer {
    public int ReadOnly => 1;
    public int WriteOnly { set { Console.Write("W" + value); } }
}
class Program {
    static void Main() {
        var item = new OptionalItem();
        Optional optional = item;
        optional.Clear();
        Console.Write(item.Raw == null ? "nil" : "wrong");
        optional.Write("x"); Console.Write(optional.Read());
        Console.Write($"|{item.Reads}:{item.Writes}|");
        var oblivious = new ObliviousItem();
        ((Oblivious)oblivious).Clear();
        Console.Write(oblivious.Raw == null ? "nil|" : "wrong|");
        ((Writer)new WriterItem()).Write();
    }
}`, "SnilSGx|1:2|Onil|W7")
        Reject(
            "interface Rejected : IValue[string] {\n    func Fail() { this.Value = nil }\n}\n",
            "GS0155",
            "2,32,2,35"
        )
        Reject(
            "interface Rejected : IOptional[string] {\n    func Read() string { return this.Value }\n}\n",
            "GS0155",
            "2,33,2,43"
        )
    }

    shared {
        private const Contract string = `#nullable enable
using System;
namespace Admission5262 {
    public interface IValue { int Value { get; set; } }
    public interface IValue<T> { T Value { get; set; } }
    public interface IForward<T> : IValue<T> {}
    public interface IOptional<T> { T? Value { get; set; } }
    public class OptionalStore : IOptional<string> {
        public string? Raw = "initial";
        public int Reads, Writes;
        string? IOptional<string>.Value {
            get { Reads++; Console.Write("G"); return Raw; }
            set { Writes++; Raw = value; Console.Write("S"); }
        }
    }
#nullable disable
    public interface IOblivious { string Value { get; set; } }
    public class ObliviousStore : IOblivious {
        public string Raw = "initial";
        string IOblivious.Value {
            get { return Raw; }
            set { Raw = value; Console.Write("O"); }
        }
    }
#nullable enable
    public interface IRestricted {
        int ReadOnly { get; }
        int WriteOnly { set; }
        int Locked { get => 0; private set {} }
    }
    public class ValueStore : IValue {
        public int Raw, Reads, Writes;
        int IValue.Value {
            get { Reads++; Console.Write("G"); return Raw; }
            set { Writes++; Raw = value; Console.Write("S" + value); }
        }
    }
    public class ValueStore<T> : IValue<T> {
        public T Raw = default!;
        public int Reads, Writes;
        T IValue<T>.Value {
            get { Reads++; Console.Write("G"); return Raw; }
            set { Writes++; Raw = value; Console.Write("S"); }
        }
    }
}`

        private func WithDirectory(action(string, []string) -> void) {
            var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while root != nil && !RepositoryRootMarker.IsRoot(root.FullName) {
                root = root.Parent
            }
            Assert.NotNull(root)
            let directory = Path.Combine(
                root!!.FullName,
                "out",
                "artifacts",
                "5389",
                "tests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                    .Split(Path.PathSeparator)
                    .Where((path string) -> Path.GetDirectoryName(path) == runtime)
                    .OrderBy((path string) -> path, StringComparer.Ordinal)
                    .ToArray()
                Assert.NotEmpty(references)
                File.WriteAllText(Path.Combine(directory, "references.json"), JsonSerializer.Serialize(references))
                Roslyn(directory, "Contract", Contract, references, false)
                action(directory, references)
            } finally {
                let evidence = Environment.GetEnvironmentVariable("GSHARP_5389_EVIDENCE_ROOT")
                if evidence != nil {
                    let destination = Path.Combine(evidence, Path.GetFileName(directory))
                    Directory.CreateDirectory(destination)
                    for file in Directory.GetFiles(directory) {
                        File.Copy(file, Path.Combine(destination, Path.GetFileName(file)))
                    }
                }
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Roslyn(directory string, name string, source string, references[]string, executable bool) {
            File.WriteAllText(Path.Combine(directory, name + ".cs"), source)
            let compilation = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    if executable {
                        OutputKind.ConsoleApplication
                    } else {
                        OutputKind.DynamicallyLinkedLibrary
                    },
                    deterministic: true
                )
            )
            using let image = File.Create(Path.Combine(directory, name + ".dll"))
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func Compile(directory string, text string, references[]string)(
            Code int32,
            Output[]uint8,
            Error string
        ) {
            let source = Path.Combine(directory, "Library.gs")
            File.WriteAllText(source, "package Output5389\nimport Admission5262\n" + text)
            let arguments = List[string]{
                typeof(Program).Assembly.Location,
                source,
                "/target:library",
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:portable",
                "/assemblyname:Library",
                "/out:" + Path.Combine(directory, "Library.dll"),
                "/refout:" + Path.Combine(directory, "Library.ref.dll"),
                "/r:" + Path.Combine(directory, "Contract.dll")
            }
            arguments.AddRange(references.Select((path string) -> "/r:" + path))
            return Run(directory, arguments)
        }

        private func Verify(directory string, target string, references[]string) {
            let arguments = List[string]{
                "tool",
                "run",
                "ilverify",
                "--",
                Path.Combine(directory, target),
                "-s",
                "System.Private.CoreLib"
            }
            for reference in references {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let result = Run(directory, arguments)
            Assert.True(result.Code == 0, Encoding.UTF8.GetString(result.Output) + result.Error)
            Assert.Empty(result.Error)
        }

        private func Execute(directory string, name string, expected string) {
            File.WriteAllText(
                Path.Combine(directory, name + ".runtimeconfig.json"),
                File.ReadAllText(Path.ChangeExtension(typeof(Program).Assembly.Location, ".runtimeconfig.json"))
            )
            let result = Run(directory, []string{Path.Combine(directory, name + ".dll")})
            Assert.Equal(0, result.Code)
            Assert.Empty(result.Error)
            Assert.Equal(Encoding.UTF8.GetBytes(expected), result.Output)
        }

        private func Check(source string, oracle string, consumer string, expected string) {
            WithDirectory(
                func (directory string, references[]string) {
                    let contract = Path.Combine(directory, "Contract.dll")
                    let contractReferences = references.Concat([]string{contract}).ToArray()
                    Roslyn(
                        directory,
                        "Oracle",
                        "using System;\nusing Admission5262;\nnamespace Output5389 {\n" +
                            oracle +
                            "\n" +
                            consumer +
                            "\n}",
                        contractReferences,
                        true
                    )
                    Verify(directory, "Contract.dll", contractReferences)
                    Verify(directory, "Oracle.dll", contractReferences)
                    Execute(directory, "Oracle", expected)
                    let compiled = Compile(directory, source, references)
                    Assert.True(compiled.Code == 0, Encoding.UTF8.GetString(compiled.Output) + compiled.Error)
                    let image = Path.Combine(directory, "Library.dll")
                    let bytes = File.ReadAllBytes(image)
                    let referenceBytes = File.ReadAllBytes(Path.Combine(directory, "Library.ref.dll"))
                    let pdbBytes = File.ReadAllBytes(Path.Combine(directory, "Library.pdb"))
                    Assert.NotEmpty(bytes)
                    {
                        using let stream = File.OpenRead(image)
                        using let pe = PEReader(stream)
                        let reader = pe.GetMetadataReader()
                        let setters = reader
                            .MemberReferences
                            .Select(reader.GetMemberReference)
                            .Where((member MemberReference) -> reader.GetString(member.Name) == "set_Value")
                            .ToArray()
                        Assert.NotEmpty(setters)
                        let metadata = List[string]()
                        for setter in setters {
                            var owner TypeReferenceHandle
                            if setter.Parent.Kind == HandleKind.TypeSpecification {
                                let specification = reader.GetTypeSpecification(TypeSpecificationHandle(setter.Parent))
                                var signature = reader.GetBlobReader(specification.Signature)
                                Assert.Equal(uint8(0x15), signature.ReadByte())
                                Assert.Equal(uint8(0x12), signature.ReadByte())
                                let encoded = signature.ReadCompressedInteger()
                                Assert.Equal(1, encoded & 3)
                                owner = MetadataTokens.TypeReferenceHandle(encoded >> 2)
                                Assert.Equal(1, signature.ReadCompressedInteger())
                                let argument = signature.ReadByte()
                                Assert.Contains(argument, []uint8{0x08, 0x0e, 0x12, 0x13})
                                if argument == 0x13 {
                                    Assert.Equal(0, signature.ReadCompressedInteger())
                                }
                                if argument == 0x12 {
                                    let payload = signature.ReadCompressedInteger()
                                    Assert.Equal(0, payload & 3)
                                    Assert.Equal(
                                        "Payload",
                                        reader.GetString(
                                            reader.GetTypeDefinition(MetadataTokens.TypeDefinitionHandle(payload >> 2))
                                                .Name
                                        )
                                    )
                                }
                                Assert.Equal(0, signature.RemainingBytes)
                                metadata.Add(Convert.ToHexString(reader.GetBlobBytes(specification.Signature)))
                            } else {
                                Assert.Equal(HandleKind.TypeReference, setter.Parent.Kind)
                                owner = TypeReferenceHandle(setter.Parent)
                            }
                            let declaring = reader.GetTypeReference(owner)
                            Assert.Equal("Admission5262", reader.GetString(declaring.Namespace))
                            Assert.Contains(
                                reader.GetString(declaring.Name),
                                []string{"IValue", "IValue`1", "IOptional`1", "IOblivious", "IRestricted"}
                            )
                            metadata.Add(
                                reader.GetString(declaring.Name) + ":" + Convert.ToHexString(
                                    reader.GetBlobBytes(setter.Signature)
                                )
                            )
                        }
                        File.WriteAllLines(Path.Combine(directory, "setter-metadata.txt"), metadata)
                    }
                    let repeated = Compile(directory, source, references)
                    Assert.True(repeated.Code == 0, Encoding.UTF8.GetString(repeated.Output) + repeated.Error)
                    Assert.Equal(compiled.Output, repeated.Output)
                    Assert.Equal(compiled.Error, repeated.Error)
                    Assert.Equal(bytes, File.ReadAllBytes(image))
                    Assert.Equal(referenceBytes, File.ReadAllBytes(Path.Combine(directory, "Library.ref.dll")))
                    Assert.Equal(pdbBytes, File.ReadAllBytes(Path.Combine(directory, "Library.pdb")))
                    Roslyn(
                        directory,
                        "Consumer",
                        "using System;\nusing Admission5262;\nusing Output5389;\n" + consumer,
                        contractReferences.Concat([]string{Path.Combine(directory, "Library.ref.dll")}).ToArray(),
                        true
                    )
                    let closure = contractReferences.Concat([]string{image, Path.Combine(directory, "Consumer.dll")})
                        .ToArray()
                    Verify(directory, "Library.dll", closure)
                    Verify(directory, "Consumer.dll", closure)
                    Execute(directory, "Consumer", expected)
                }
            )
        }

        private func Reject(source string, diagnostic string, span string) {
            WithDirectory(
                func (directory string, references[]string) {
                    let compiled = Compile(directory, source, references)
                    let text = Encoding.UTF8.GetString(compiled.Output) + compiled.Error
                    Assert.Equal(1, compiled.Code)
                    let errors = Regex.Matches(text, `Library\.gs\(([^)]+)\): error (GS\d+):`)
                    let error = Assert.Single(errors.Cast[Match]())
                    Assert.Equal(diagnostic, error.Groups[2].Value)
                    let coordinates = span.Split(',')
                    coordinates[0] = (int32.Parse(coordinates[0]) + 2).ToString()
                    coordinates[2] = (int32.Parse(coordinates[2]) + 2).ToString()
                    Assert.Equal(string.Join(",", coordinates), error.Groups[1].Value)
                    for extension in[]string{".dll", ".ref.dll", ".pdb"} {
                        Assert.False(File.Exists(Path.Combine(directory, "Library" + extension)), text)
                    }
                }
            )
        }

        private func Run(directory string, arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
            let prefix = Path.Combine(
                directory,
                "run-" + Directory.GetFiles(directory, "*.argv.json").Length.ToString()
            )
            File.WriteAllText(prefix + ".argv.json", JsonSerializer.Serialize(arguments.Prepend("dotnet").ToArray()))
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            var exited bool
            try {
                exited = process.WaitForExit(60_000)
            } finally {
                if !process.HasExited {
                    process.Kill(entireProcessTree: true)
                }
                process.WaitForExit()
                read.GetAwaiter().GetResult()
                error.GetAwaiter().GetResult()
            }
            File.WriteAllBytes(prefix + ".stdout", output.ToArray())
            File.WriteAllText(prefix + ".stderr", error.Result)
            File.WriteAllText(prefix + ".exit", process.ExitCode.ToString())
            Assert.True(exited, "property driver timed out")
            return (process.ExitCode, output.ToArray(), error.Result)
        }
    }
}
