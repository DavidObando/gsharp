package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5260ImportedFunctionPointerDriverTests {
    @Fact
    func SeparateGSharpProducer_AssignsTheOriginalSignatureAndPreservesSourceControl() {
        using let fixture = CSharpFixture("public class DirectoryOwner {}")
        let control = Compile(
            fixture.DirectoryPath,
            "Control",
            Producer + Consumer.Replace("import Fixture", "").Replace("Dispatch()", "Dispatch{}")
        )
        Assert.True(control.Code == 0, control.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(control.Path))

        let producer = Compile(fixture.DirectoryPath, "Fixture", Producer, executable: false)
        Assert.True(producer.Code == 0, producer.Diagnostics)
        let consumer = Compile(fixture.DirectoryPath, "Consumer", Consumer, producer.Path)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(consumer.Path))
        let image = File.ReadAllBytes(consumer.Path)
        Assert.NotEmpty(image)
        let repeated = Compile(fixture.DirectoryPath, "Consumer", Consumer, producer.Path)
        Assert.True(repeated.Code == 0, repeated.Diagnostics)
        Assert.Equal(image, File.ReadAllBytes(repeated.Path))
    }

    @Fact
    func RoslynProducer_ProjectsAnOverrideSignatureWithoutAnInternalError() {
        using let fixture = CSharpFixture(Contract, assemblyName: "Contracts", allowUnsafe: true)
        const source = `import Contracts
unsafe class Derived : Base[int32] {
    override func Get() unmanaged[Cdecl](nint) -> nint { return nil }
}
unsafe func Main() {
    let value Base[int32] = Derived()
    let pointer unmanaged[Cdecl](nint) -> nint = value.Get()
    System.Console.Write(pointer == nil)
}`
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("True"), Run(consumer.Path))
    }

    @Fact
    func RoslynProducer_ProjectsFieldsPropertiesAndReturnsThroughGenericReceiver() {
        using let fixture = CSharpFixture(Contract, assemblyName: "Contracts", allowUnsafe: true)
        const source = `import System
import Contracts
struct Payload { var Value int32 }
func Increment(value nint) nint -> value + 1
unsafe func Main() {
    let api = Api[Payload]()
    let pointer = cast[unmanaged[Cdecl](*Payload, nuint) -> *Payload](nint(0))
    api.Value = pointer
    api.Property = pointer
    let field unmanaged[Cdecl](*Payload, nuint) -> *Payload = api.Value
    let property unmanaged[Cdecl](*Payload, nuint) -> *Payload = api.Property
    let result unmanaged[Cdecl](*Payload, nuint) -> *Payload = api.Get()
    api.Managed = &Increment
    let managed *func(nint) nint = api.Managed
    let stdcall unmanaged[Stdcall](nint) -> nint = api.Stdcall
    let extended unmanaged[Cdecl, SuppressGCTransition](nint) -> nint = api.Extended
    let platform unmanaged(nint) -> nint = api.Platform
    Console.Write(managed(nint(41)))
    Console.Write("|")
    Console.Write(field == nil && property == nil && result == nil)
    Console.Write("|")
    Console.Write(stdcall == nil && extended == nil && platform == nil)
}`
        let consumer = Compile(fixture.DirectoryPath, "Consumer", source, fixture.AssemblyPath)
        Assert.True(consumer.Code == 0, consumer.Diagnostics)
        Assert.Equal(Encoding.UTF8.GetBytes("42|True|True"), Run(consumer.Path))
    }

    @Theory
    @InlineData("*func(nint, uint64, *Callbacks)", "nil")
    @InlineData("unmanaged[Stdcall](nint, uint64, *Callbacks) -> void", "nint(0)")
    @InlineData("unmanaged[Cdecl](nuint, uint64, *Callbacks) -> void", "nint(0)")
    @InlineData("unmanaged[Cdecl](nint, uint64, *Callbacks) -> nint", "nint(0)")
    func ImportedField_RejectsDifferentAbiOrSignatureWithAnExactDiagnostic(type string, value string) {
        using let fixture = CSharpFixture("public class DirectoryOwner {}")
        let producer = Compile(fixture.DirectoryPath, "Fixture", Producer, executable: false)
        Assert.True(producer.Code == 0, producer.Diagnostics)
        let expression = "cast[" + type + "](" + value + ")"
        let source = "import Fixture\nunsafe func Reject(dispatch Dispatch) {\n    dispatch.Destroy = " +
            expression +
            "\n}"
        let consumer = Compile(fixture.DirectoryPath, "Rejected", source, producer.Path, executable: false)
        Assert.NotEqual(0, consumer.Code)
        Assert.False(File.Exists(consumer.Path))
        let errors = Regex.Matches(consumer.Diagnostics, `\((\d+),(\d+),(\d+),(\d+)\): error (GS\d+): ([^\r\n]*)`)
        let error = Assert.Single(errors)
        Assert.Equal("3", error.Groups[1].Value)
        Assert.Equal("24", error.Groups[2].Value)
        Assert.Equal("3", error.Groups[3].Value)
        Assert.Equal((24 + expression.Length).ToString(), error.Groups[4].Value)
        Assert.Equal("GS0156", error.Groups[5].Value)
        Assert.EndsWith(
            "to 'unmanaged[Cdecl] (nint, uint64, *Fixture.Callbacks) -> void'. An explicit conversion exists (are you missing a cast?)",
            error.Groups[6].Value
        )
    }

    shared {
        private const Producer string = `package Fixture
import System.Runtime.InteropServices
@StructLayout(LayoutKind.Sequential)
public struct Callbacks { public var UserData nint }
@StructLayout(LayoutKind.Sequential)
public unsafe struct Dispatch { public var Destroy unmanaged[Cdecl](nint, uint64, *Callbacks) -> void }
`

        private const Consumer string = `import Fixture
@System.Runtime.InteropServices.UnmanagedCallersOnly
unsafe func Destroy(device nint, pool uint64, callbacks *Callbacks) {}
unsafe func Probe() {
 var dispatch = Dispatch()
 dispatch.Destroy = cast[unmanaged[Cdecl](nint, uint64, *Callbacks) -> void](nint(&Destroy))
}
unsafe func Main() {
 var dispatch = Dispatch()
 dispatch.Destroy = cast[unmanaged[Cdecl](nint, uint64, *Callbacks) -> void](nint(&Destroy))
 System.Console.Write(nint(dispatch.Destroy) == nint(&Destroy))
}`

        private const Contract string = `namespace Contracts {
    public unsafe class Api<T> where T : unmanaged {
        public delegate* unmanaged[Cdecl]<T*, nuint, T*> Value;
        public delegate* unmanaged[Cdecl]<T*, nuint, T*> Property { get; set; }
        public delegate* unmanaged[Cdecl]<T*, nuint, T*> Get() => Value;
        public delegate*<nint, nint> Managed;
        public delegate* unmanaged[Stdcall]<nint, nint> Stdcall;
        public delegate* unmanaged[Cdecl, SuppressGCTransition]<nint, nint> Extended;
        public delegate* unmanaged<nint, nint> Platform;
    }
    public unsafe class Base<T> {
        public virtual delegate* unmanaged[Cdecl]<nint, nint> Get() => null;
    }
}`

        private func Compile(
            directory string,
            name string,
            source string,
            reference string? = nil,
            executable bool = true
        )(Code int32, Diagnostics string, Path string) {
            let sourcePath = Path.Combine(directory, name + ".gs")
            let outputPath = Path.Combine(directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let arguments = List[string]{
                if executable {
                    "/target:exe"
                } else {
                    "/target:library"
                },
                "/targetframework:net10.0",
                "/deterministic+",
                "/debug:none",
                "/out:" + outputPath,
                sourcePath
            }
            if reference != nil {
                arguments.Add("/reference:" + reference)
            }
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let originalOut = Console.Out
            let originalError = Console.Error
            var code int32
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                code = Program.Main(arguments.ToArray())
            } finally {
                Console.SetOut(originalOut)
                Console.SetError(originalError)
            }
            return (code, stdout.ToString() + stderr.ToString(), outputPath)
        }

        private func Run(assembly string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(assembly)!!
            }
            start.ArgumentList.Add(assembly)
            using let process = Process.Start(start)!!
            let stderr = process.StandardError.ReadToEndAsync()
            using let stdout = MemoryStream()
            let readOutput = process.StandardOutput.BaseStream.CopyToAsync(stdout)
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("function-pointer consumer timed out")
            }
            readOutput.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
            return stdout.ToArray()
        }
    }
}
