package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
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
import Xunit

class Issue5391InheritedImportedEventDriverTests {
    @Fact
    func QualifiedDefaultBodies_CallInheritedAccessorsWithoutChangingLexicalDelegate() {
        Check(`import System
import Constructed5262
interface Extended : IEvents {
    func Attach(handler Action) { this.Changed += handler }
    func Detach(handler Action) { this.Changed -= handler }
}
class Outer {
    shared {
        var Changed Action? = nil
        func Raise() {
            System.Console.Write("O")
            Changed?()
        }
        func Target(value Extended) Extended {
            System.Console.Write("T")
            return value
        }
        func Handler(value Action) Action {
            System.Console.Write("H")
            return value
        }
        func Attach(value Extended, handler Action) { Target(value).Changed += Handler(handler) }
        func Detach(value Extended, handler Action) { Target(value).Changed -= Handler(handler) }
    }
    interface Nested : IEvents {
        func Attach(handler Action) { this.Changed += handler }
        func Detach(handler Action) { this.Changed -= handler }
    }
}
`, `using System;
using Default;
using Constructed5262;
class First : Emitter, Extended {}
class Second : Emitter, Outer.Nested {}
class Program {
    static void Main() {
        Extended first = new First();
        Action handler = () => Console.Write("X");
        first.Attach(handler); first.Fire(); first.Detach(handler); first.Fire();
        Console.Write("|");
        Outer.Attach(first, handler); first.Fire(); Outer.Detach(first, handler); first.Fire();
        Console.Write("|");
        Outer.Nested second = new Second();
        second.Attach(handler); second.Fire(); Outer.Raise(); second.Detach(handler); second.Fire();
    }
}`, "AFXRF|THAFXTHRF|AFXORF", generic: false)
    }

    @Fact
    func GenericInheritedContracts_PreserveOpenClosedAndSourceArguments() {
        Check(`import System
import Constructed5262
interface Forward[T] : IForward[T] { }
interface Extended[T] : Forward[T] {
    func Attach(handler Action[T]) { this.Changed += handler }
    func Detach(handler Action[T]) { this.Changed -= handler }
}
interface Closed : Forward[int32] {
    func Attach(handler Action[int32]) { this.Changed += handler }
    func Detach(handler Action[int32]) { this.Changed -= handler }
}
class Payload { func Mark() { System.Console.Write("P") } }
interface Source : Forward[Payload] {
    func Attach(handler Action[Payload]) { this.Changed += handler }
    func Detach(handler Action[Payload]) { this.Changed -= handler }
}
`, `using System;
using Default;
using Constructed5262;
class Open : Emitter<string>, Extended<string> {}
class Concrete : Emitter<int>, Closed {}
class Local : Emitter<Payload>, Source {}
class Program {
    static void Main() {
        Extended<string> open = new Open();
        Action<string> text = value => Console.Write(value);
        open.Attach(text); open.Fire("S"); open.Detach(text); open.Fire("unused");
        Console.Write("|");
        Closed closed = new Concrete();
        Action<int> number = value => Console.Write(value);
        closed.Attach(number); closed.Fire(7); closed.Detach(number); closed.Fire(99);
        Console.Write("|");
        Source local = new Local();
        Action<Payload> payload = value => value.Mark();
        local.Attach(payload); local.Fire(new Payload()); local.Detach(payload); local.Fire(new Payload());
    }
}`, "AFSRF|AF7RF|AFPRF", generic: true)
    }

    shared {
        private const Contract string = `using System;
namespace Constructed5262 {
    public interface IEvents { event Action Changed; void Fire(); }
    public interface IEvents<T> { event Action<T> Changed; void Fire(T value); }
    public interface IForward<T> : IEvents<T> {}
    public class Emitter : IEvents {
        Action handlers;
        public event Action Changed {
            add { Console.Write("A"); handlers += value; }
            remove { Console.Write("R"); handlers -= value; }
        }
        public void Fire() { Console.Write("F"); handlers?.Invoke(); }
    }
    public class Emitter<T> : IEvents<T> {
        Action<T> handlers;
        public event Action<T> Changed {
            add { Console.Write("A"); handlers += value; }
            remove { Console.Write("R"); handlers -= value; }
        }
        public void Fire(T value) { Console.Write("F"); handlers?.Invoke(value); }
    }
}`

        private func WithDirectory(action(string, []string) -> void) {
            var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while root != nil && !RepositoryRootMarker.IsRoot(root.FullName) {
                root = root.Parent
            }
            Assert.NotNull(root)
            let directory = Path.Combine(root!!.FullName, "out", "5391", "tests", Guid.NewGuid().ToString("N"))
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
                action(directory, references)
            } finally {
                let evidence = Environment.GetEnvironmentVariable("GSHARP_5391_EVIDENCE_ROOT")
                if evidence != nil {
                    Directory.CreateDirectory(evidence)
                    let destination = Path.Combine(evidence, Path.GetFileName(directory))
                    Directory.CreateDirectory(destination)
                    for file in Directory.GetFiles(directory) {
                        File.Copy(file, Path.Combine(destination, Path.GetFileName(file)))
                    }
                }
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Produce(directory string, references[]string) {
            File.WriteAllText(Path.Combine(directory, "EventContracts5391.cs"), Contract)
            Roslyn(directory, "EventContracts5391", Contract, references, executable: false)
        }

        private func Roslyn(directory string, name string, source string, references[]string, executable bool) {
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
            if !executable {
                using let reference = File.Create(Path.Combine(directory, name + ".ref.dll"))
                let emitted = compilation.Emit(
                    reference,
                    options: EmitOptions(metadataOnly: true, includePrivateMembers: false)
                )
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
        }

        private func Compile(directory string, source string, image string, references[]string)(
            Code int32,
            Output[]uint8,
            Error string
        ) {
            let arguments = List[string]{
                typeof(Program).Assembly.Location,
                source,
                "/target:library",
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:portable",
                "/assemblyname:" + Path.GetFileNameWithoutExtension(image),
                "/out:" + image,
                "/refout:" + Path.ChangeExtension(image, ".ref.dll"),
                "/r:" + Path.Combine(directory, "EventContracts5391.ref.dll")
            }
            arguments.AddRange(references.Select((path string) -> "/r:" + path))
            return Run(directory, arguments)
        }

        private func Check(sourceText string, consumer string, expected string, generic bool) {
            WithDirectory(
                func (directory string, references[]string) {
                    Produce(directory, references)
                    let source = Path.Combine(directory, "ImportedEvents.gs")
                    let image = Path.Combine(directory, "Events.dll")
                    File.WriteAllText(source, sourceText)
                    let compiled = Compile(directory, source, image, references)
                    Assert.True(compiled.Code == 0, Encoding.UTF8.GetString(compiled.Output) + compiled.Error)
                    let bytes = File.ReadAllBytes(image)
                    let refBytes = File.ReadAllBytes(Path.ChangeExtension(image, ".ref.dll"))
                    let pdbBytes = File.ReadAllBytes(Path.ChangeExtension(image, ".pdb"))
                    Assert.NotEmpty(bytes)
                    Assert.NotEmpty(refBytes)
                    Assert.NotEmpty(pdbBytes)
                    {
                        using let stream = File.OpenRead(image)
                        using let pe = PEReader(stream)
                        let reader = pe.GetMetadataReader()
                        let accessors = reader
                            .MemberReferences
                            .Select(reader.GetMemberReference)
                            .Where(
                            (member MemberReference) -> reader.GetString(member.Name) == "add_Changed" ||
                                reader.GetString(member.Name) == "remove_Changed"
                        )
                            .ToArray()
                        Assert.NotEmpty(accessors)
                        Assert.Contains(
                            accessors,
                            (member MemberReference) -> reader.GetString(member.Name) == "add_Changed"
                        )
                        Assert.Contains(
                            accessors,
                            (member MemberReference) -> reader.GetString(member.Name) == "remove_Changed"
                        )
                        let owners = HashSet[string](StringComparer.Ordinal)
                        let metadata = List[string]()
                        for accessor in accessors {
                            Assert.Equal(
                                if generic {
                                    HandleKind.TypeSpecification
                                } else {
                                    HandleKind.TypeReference
                                },
                                accessor.Parent.Kind
                            )
                            if !generic {
                                let owner = reader.GetTypeReference(TypeReferenceHandle(accessor.Parent))
                                Assert.Equal("IEvents", reader.GetString(owner.Name))
                                Assert.Equal("Constructed5262", reader.GetString(owner.Namespace))
                            } else {
                                let specification = reader.GetTypeSpecification(
                                    TypeSpecificationHandle(accessor.Parent)
                                )
                                var owner = reader.GetBlobReader(specification.Signature)
                                Assert.Equal(uint8(0x15), owner.ReadByte())
                                Assert.Equal(uint8(0x12), owner.ReadByte())
                                Assert.Equal("IEvents`1", TypeName(reader, owner.ReadCompressedInteger()))
                                Assert.Equal(1, owner.ReadCompressedInteger())
                                let argument = owner.ReadByte()
                                if argument == 0x13 {
                                    Assert.Equal(0, owner.ReadCompressedInteger())
                                    owners.Add("T")
                                } else if argument == 0x08 {
                                    owners.Add("int32")
                                } else {
                                    Assert.Equal(uint8(0x12), argument)
                                    let name = TypeName(reader, owner.ReadCompressedInteger())
                                    Assert.Equal("Payload", name)
                                    owners.Add(name)
                                }
                                Assert.Equal(0, owner.RemainingBytes)
                                metadata.Add(Convert.ToHexString(reader.GetBlobBytes(specification.Signature)))
                            }
                            var signature = reader.GetBlobReader(accessor.Signature)
                            Assert.Equal(uint8(0x20), signature.ReadByte())
                            Assert.Equal(1, signature.ReadCompressedInteger())
                            Assert.Equal(uint8(0x01), signature.ReadByte())
                            if generic {
                                Assert.Equal(uint8(0x15), signature.ReadByte())
                            }
                            Assert.Equal(uint8(0x12), signature.ReadByte())
                            Assert.Equal(
                                if generic {
                                    "Action`1"
                                } else {
                                    "Action"
                                },
                                TypeName(reader, signature.ReadCompressedInteger())
                            )
                            if generic {
                                Assert.Equal(1, signature.ReadCompressedInteger())
                                Assert.Equal(uint8(0x13), signature.ReadByte())
                                Assert.Equal(0, signature.ReadCompressedInteger())
                            }
                            Assert.Equal(0, signature.RemainingBytes)
                            metadata.Add(
                                reader.GetString(accessor.Name) + ":" + Convert.ToHexString(
                                    reader.GetBlobBytes(accessor.Signature)
                                )
                            )
                        }
                        if generic {
                            Assert.Equal(
                                []string{"Payload", "T", "int32"},
                                owners.OrderBy((owner string) -> owner, StringComparer.Ordinal).ToArray()
                            )
                        }
                        File.WriteAllLines(Path.Combine(directory, "accessor-metadata.txt"), metadata)
                    }
                    let repeated = Compile(directory, source, image, references)
                    Assert.Equal(0, repeated.Code)
                    Assert.Equal(compiled.Output, repeated.Output)
                    Assert.Equal(compiled.Error, repeated.Error)
                    Assert.Equal(bytes, File.ReadAllBytes(image))
                    Assert.Equal(refBytes, File.ReadAllBytes(Path.ChangeExtension(image, ".ref.dll")))
                    Assert.Equal(pdbBytes, File.ReadAllBytes(Path.ChangeExtension(image, ".pdb")))
                    File.WriteAllText(Path.Combine(directory, "Consumer.cs"), consumer)
                    Roslyn(
                        directory,
                        "Consumer",
                        consumer,
                        references.Concat(
                            []string{
                                Path.Combine(directory, "EventContracts5391.ref.dll"),
                                Path.ChangeExtension(image, ".ref.dll")
                            }
                        )
                            .ToArray(),
                        executable: true
                    )
                    let closure = references.Concat(
                        []string{
                            Path.Combine(directory, "EventContracts5391.dll"),
                            image,
                            Path.Combine(directory, "Consumer.dll")
                        }
                    )
                        .ToArray()
                    for target in[]string{"EventContracts5391.dll", "Events.dll", "Consumer.dll"} {
                        let verify = List[string]{
                            "tool",
                            "run",
                            "ilverify",
                            "--",
                            Path.Combine(directory, target),
                            "-s",
                            "System.Private.CoreLib"
                        }
                        for reference in closure {
                            verify.Add("-r")
                            verify.Add(reference)
                        }
                        let verified = Run(directory, verify)
                        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
                        Assert.Empty(verified.Error)
                    }
                    File.WriteAllText(
                        Path.Combine(directory, "Consumer.runtimeconfig.json"),
                        File.ReadAllText(Path.ChangeExtension(typeof(Program).Assembly.Location, ".runtimeconfig.json"))
                    )
                    let executed = Run(directory, []string{Path.Combine(directory, "Consumer.dll")})
                    Assert.Equal(0, executed.Code)
                    Assert.Empty(executed.Error)
                    Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Output)
                }
            )
        }

        private func TypeName(reader MetadataReader, encoded int32) string -> if (encoded & 3) == 0 {
            reader.GetString(reader.GetTypeDefinition(MetadataTokens.TypeDefinitionHandle(encoded >> 2)).Name)
        } else {
            reader.GetString(reader.GetTypeReference(MetadataTokens.TypeReferenceHandle(encoded >> 2)).Name)
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
            Assert.True(exited, "event driver timed out")
            return (process.ExitCode, output.ToArray(), error.Result)
        }
    }
}
