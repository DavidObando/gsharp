package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import Xunit

class Issue5477InterfaceTypeParameterScopeDriverTests {
    @Fact
    func ReportedDefaultBody_ResolvesInterfaceTypeParameter() {
        Check(`interface IBox[T] {
    func Echo(value T) T {
        Storage[T].Events += "D"
        return value
    }
}
class Storage[T] { shared { var Events string = "" } }
class Default : IBox[int32] { }
let item IBox[int32] = Default()
System.Console.Write(item.Echo(9))
`, "9")
    }

    @Fact
    func InheritedDefaultBody_PreservesStorageIsolationAndOnceOnlyEffects() {
        Check(`interface IBox[T] {
    func Echo(value T) T {
        Storage[T].Events += Trace.Rhs()
        return value
    }
}
interface Forward[T] : IBox[T] {
    func Read(value T) T { return Echo(value) }
}
class Storage[T] { shared { var Events string = "" } }
class DefaultInt : Forward[int32] { }
class DefaultString : IBox[string] { }
class Trace {
    shared {
        var Log string = ""
        var Calls int32 = 0
        func Target() Forward[int32] {
            Log += "R"
            return DefaultInt()
        }
        func Argument() int32 {
            Log += "A"
            return 9
        }
        func Rhs() string {
            Log += "D"
            Calls++
            return "D"
        }
    }
}
class Ordinary[T] {
    func Record(value T) T {
        Storage[T].Events += "I"
        return value
    }
    shared {
        func RecordStatic(value T) T {
            Storage[T].Events += "S"
            return value
        }
    }
}
func Record[T](value T) T {
    Storage[T].Events += "F"
    return value
}
let first IBox[int32] = DefaultInt()
let second IBox[string] = DefaultString()
System.Console.Write(first.Echo(7))
System.Console.Write("|")
System.Console.Write(Trace.Target().Read(Trace.Argument()))
System.Console.Write("|")
System.Console.Write(second.Echo("value"))
System.Console.Write("|")
System.Console.Write(Ordinary[int32]().Record(11))
System.Console.Write("|")
System.Console.Write(Ordinary[string].RecordStatic("static"))
System.Console.Write("|")
System.Console.Write(Record[int32](13))
System.Console.Write("|")
System.Console.Write(Storage[int32].Events)
System.Console.Write("|")
System.Console.Write(Storage[string].Events)
System.Console.Write("|")
System.Console.Write(Trace.Log)
System.Console.Write("|")
System.Console.Write(Trace.Calls)
`, "7|9|value|11|static|13|DDIF|DS|DRADD|3", methodParameter: true)
    }

    @Fact
    func MethodTypeParameter_ShadowsInterfaceTypeParameterWithoutChangingOwner() {
        Check(`interface IBox[T] {
    func Echo(value T) T {
        Storage[T].Events += "D"
        return value
    }
    func Pick[T](value T) T {
        Storage[T].Events += "M"
        return value
    }
}
class Storage[T] { shared { var Events string = "" } }
class Default : IBox[int32] { }
let item IBox[int32] = Default()
System.Console.Write(item.Pick[string]("tag"))
System.Console.Write("|")
System.Console.Write(item.Echo(9))
System.Console.Write("|")
System.Console.Write(Storage[int32].Events)
System.Console.Write("|")
System.Console.Write(Storage[string].Events)
`, "tag|9|D|M", methodParameter: true)
    }

    shared {
        private func Check(sourceText string, expected string, methodParameter bool = false) {
            var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while root != nil && !RepositoryRootMarker.IsRoot(root.FullName) {
                root = root.Parent
            }
            Assert.NotNull(root)
            let directory = Path.Combine(root!!.FullName, "out", "5477", "tests", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let source = Path.Combine(directory, "Program.gs")
                let image = Path.Combine(directory, "Program.dll")
                let reference = Path.Combine(directory, "Program.ref.dll")
                let pdb = Path.ChangeExtension(image, ".pdb")
                File.WriteAllText(source, sourceText)
                let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                    .Split(Path.PathSeparator)
                    .Where((path string) -> Path.GetDirectoryName(path) == runtimeDirectory)
                    .OrderBy((path string) -> path, StringComparer.Ordinal)
                    .ToArray()
                Assert.NotEmpty(references)
                let arguments = List[string]{
                    typeof(Program).Assembly.Location,
                    source,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/deterministic+",
                    "/debug:portable",
                    "/out:" + image,
                    "/refout:" + reference
                }
                arguments.AddRange(references.Select((path string) -> "/r:" + path))
                let compiled = Run(arguments)
                Assert.True(compiled.Code == 0, Encoding.UTF8.GetString(compiled.Output) + compiled.Error)
                Assert.Empty(compiled.Error)
                let bytes = File.ReadAllBytes(image)
                let refBytes = File.ReadAllBytes(reference)
                let pdbBytes = File.ReadAllBytes(pdb)
                Assert.NotEmpty(bytes)
                Assert.NotEmpty(refBytes)
                Assert.NotEmpty(pdbBytes)
                AssertStorageOwners(image, methodParameter)
                let verify = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
                for path in references {
                    verify.Add("-r")
                    verify.Add(path)
                }
                let verified = Run(verify)
                Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
                Assert.Empty(verified.Error)
                let executed = Run([]string{image})
                Assert.Equal(0, executed.Code)
                Assert.Empty(executed.Error)
                Assert.Equal(Encoding.UTF8.GetBytes(expected), executed.Output)
                let repeated = Run(arguments)
                Assert.Equal(0, repeated.Code)
                Assert.Equal(compiled.Output, repeated.Output)
                Assert.Equal(compiled.Error, repeated.Error)
                Assert.Equal(bytes, File.ReadAllBytes(image))
                Assert.Equal(refBytes, File.ReadAllBytes(reference))
                Assert.Equal(pdbBytes, File.ReadAllBytes(pdb))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func AssertStorageOwners(image string, methodParameter bool) {
            using let stream = File.OpenRead(image)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let storage = Assert.Single(
                reader.TypeDefinitions.Where(
                    (handle TypeDefinitionHandle) -> reader.GetString(
                        reader.GetTypeDefinition(handle).Name
                    ) == "Storage`1"
                )
            )
            let parameters = HashSet[int32]()
            let fields = reader
                .MemberReferences
                .Select(reader.GetMemberReference)
                .Where((member MemberReference) -> reader.GetString(member.Name) == "Events")
                .ToArray()
            Assert.NotEmpty(fields)
            for field in fields {
                Assert.Equal([]uint8{0x06, 0x0E}, reader.GetBlobBytes(field.Signature))
                Assert.Equal(HandleKind.TypeSpecification, field.Parent.Kind)
                let specification = reader.GetTypeSpecification(TypeSpecificationHandle(field.Parent))
                var signature = reader.GetBlobReader(specification.Signature)
                Assert.Equal(uint8(0x15), signature.ReadByte())
                Assert.Equal(uint8(0x12), signature.ReadByte())
                Assert.Equal(MetadataTokens.GetRowNumber(storage) << 2, signature.ReadCompressedInteger())
                Assert.Equal(1, signature.ReadCompressedInteger())
                let argument = signature.ReadByte()
                if argument == 0x13 || argument == 0x1E {
                    parameters.Add(argument)
                    Assert.Equal(0, signature.ReadCompressedInteger())
                }
            }
            Assert.Contains(0x13, parameters)
            if methodParameter {
                Assert.Contains(0x1E, parameters)
            }
        }

        private func Run(arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
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
                exited = process.WaitForExit(30_000)
            } finally {
                if !process.HasExited {
                    process.Kill(entireProcessTree: true)
                }
                process.WaitForExit()
                try {
                    read.GetAwaiter().GetResult()
                } finally {
                    error.GetAwaiter().GetResult()
                }
            }
            Assert.True(exited, "Interface type-parameter driver exceeded 30 seconds.")
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }
    }
}
