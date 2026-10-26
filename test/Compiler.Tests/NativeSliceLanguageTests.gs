// <copyright file="NativeSliceLanguageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Gsharp.Values
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection
import Xunit.Sdk

/// Real-driver, verifier and runtime witnesses for native buffer semantics.
class NativeSliceLanguageTests {
    @Theory
    @MemberData("Programs")
    func NativeProgramsVerifyAndExecute(source string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(source, "program", executable: true)
        if source.Contains("package NativeModifiers", StringComparison.Ordinal) {
            AssertForwardingBodies(dll, "Borrow", "BorrowView", "ReadBorrowView")
            // Existing ADR-0181 verifier limitation: bare ref-parameter forwards
            // fail ReturnPtrToStack even in Roslyn. The independent parity test
            // below pins ldarg.0/ret and verifies every other method strictly.
            IlVerifier.Verify(
                dll,
                ignoredErrorCodes: IlVerifier.KnownIssues.RefStruct,
                ignoredErrorScope: "(Borrow|BorrowView|ReadBorrowView)$$"
            )
        } else {
            IlVerifier.Verify(dll)
        }
        Assert.Equal(expected, fixture.Run(dll))
    }

    @Theory
    @InlineData("let s = readonly slice[int32]{1}\ns[0] = 2", "GS0603", int32(5))
    @InlineData("let s = readonly slice[int32]{1}\ns[0] += 2", "GS0603", int32(5))
    @InlineData("let s = slice[int32]{1}\nlet raw array[int32] = s", "GS0155", int32(5))
    @InlineData("let s slice[object] = slice[string]{\"a\"}", "GS0155", int32(4))
    @InlineData("let s slice[int32] = nil", "GS0155", int32(4))
    @InlineData("let s slice[Span[int32]]", "GS0601", int32(4))
    @InlineData("let s readonly map[string,int32]", "GS0005", int32(4))
    @InlineData("let s = slice[string]{\"a\"}\nlet wide slice[string?] = s", "GS0155", int32(5))
    @InlineData("let s = slice[int32]{1}\nlet missing = s == nil", "GS0129", int32(5))
    @InlineData("let s = readonly slice[int32]{1}\nlet raw = s.TryGetArray(out var owner)", "GS0159", int32(5))
    @InlineData("let s = slice[int32]{1}\nlet same = s == s.AsReadOnly()", "GS0129", int32(5))
    @InlineData("let absent slice[int32]? = nil\nlet value = absent[0]", "GS0116", int32(5))
    @InlineData("let s = slice[int32]{1}\nlet view = s.Slice(0, 1)", "GS0159", int32(5))
    @InlineData("let raw = array[string?]{nil}\nlet s = slice[string].FromArray(raw)", "GS0601", int32(5))
    @InlineData("let raw = array[string]{\"a\"}\nlet s = slice[string?].FromArray(raw)", "GS0601", int32(5))
    @InlineData(
        "let source = slice[string?]{nil}\nlet ok = slice[string].TryFromMemory(source.AsMemory(), out var result)",
        "GS0601",
        int32(5)
    )
    @InlineData(`let source = slice[string?]{nil}
for value in source {
let nonnull string = value
}`, "GS0155", int32(6))
    @InlineData(`let s slice[int32]? = nil
let r readonly slice[int32]? = nil
let same = s == r`, "GS0129", int32(6))
    @InlineData("var s $$slice[int32]", "GS0113", int32(4))
    @InlineData("var s $$array[int32]", "GS0113", int32(4))
    func RejectedRepresentationsReportDiagnostics(statement string, diagnostic string, line int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package NativeReject
import System
func Main() {
` + statement + "\n}", "reject", true)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains(diagnostic, StringComparison.Ordinal), output)
        Assert.Contains(".gs($line,", output, StringComparison.Ordinal)
    }

    @Fact
    func SourceAndClrStaticImportsWinOverNativeAliases() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        for name in[]string{"slice", "array"} {
            for kind in[]string{"field", "property", "method"} {
                let invocation = if kind == "method" {
                    "$name[int32](42)"
                } else {
                    "$name[index](41)"
                }
                let sourceMember = switch kind {
                    case "field": "public var $name []Func[int32, int32] = []Func[int32, int32]{func(value int32) int32 { return value + 1 } }"
                    case "property": (`private var items []Func[int32, int32] = []Func[int32, int32]{func(value int32) int32 { return value + 1 } }
public prop ` + "$name" + ` []Func[int32, int32] -> items`)
                    default: "public func $name[T](value T) T { return value }"
                }
                let source = (`package SourceStaticImports
import System
import SourceStaticImports.Registry
class Registry {
    shared {
        ` + "$sourceMember" + `
    }
}
func Main() {
    let index = 0
    Console.WriteLine(` + "$invocation" + `)
}`)
                let sourceDll = fixture.Compile(source, "SourceStaticImports", true)
                IlVerifier.Verify(sourceDll)
                Assert.Equal("42\n", fixture.Run(sourceDll))
                let clrMember = switch kind {
                    case "field": "public static Func<int, int>[] $name = { value => value + 1 };"
                    case "property": "public static Func<int, int>[] $name => new Func<int, int>[] { value => value + 1 };"
                    default: "public static T $name<T>(T value) => value;"
                }
                let libraryName = "StaticImports" + name + kind
                let library = fixture.CompileCSharp((`using System;
namespace ` + "$libraryName" + `;
public static class Registry { ` + "$clrMember" + ` }`), libraryName)
                let consumer = fixture.Compile((`package ClrStaticImports
import System
import ` + "$libraryName" + `.Registry
func Main() {
    let index = 0
    Console.WriteLine(` + "$invocation" + `)
}`), "ClrStaticImports", true, "/r:" + library)
                IlVerifier.Verify(consumer, []string{library})
                Assert.Equal("42\n", fixture.Run(consumer))
            }
        }
    }

    @Fact
    func OrdinaryImportedAliasesArityAmbiguityAndReadonlyNeverFallBack() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace ShadowOne {
    public class slice<T> { public T Value = default!; }
    public class array<T> { public T Value = default!; }
}
namespace ShadowTwo {
    public class slice<T> { }
    public class array<T> { }
}
namespace WrongArity {
    public class slice<T, U> { }
    public class array<T, U> { }
}
namespace Constrained {
    public class slice<T> where T : class { }
    public class array<T> where T : class { }
}`, "OrdinaryNames")
        let dll = fixture.Compile(`package ImportedNames
import System
import ShadowOne
import buffer = ShadowOne.slice
func Main() {
    let a = slice[int32]{Value: 3}
    let b = array[int32]{Value: 5}
    let c = buffer[int32]{Value: 7}
    Console.WriteLine(a.Value + b.Value + c.Value)
}`, "ImportedNames", true, "/r:" + library)
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal("15\n", fixture.Run(dll))
        let aliasConsumer = fixture.Compile(`package ImportedAliasNames
import System
import slice = ShadowOne.slice
import array = ShadowOne.array
func Main() {
    let a = slice[int32]{Value: 2}
    let b = $slice[int32]{Value: 3}
    let c = array[int32]{Value: 5}
    let d = $array[int32]{Value: 7}
    Console.WriteLine(a.Value + b.Value + c.Value + d.Value)
}`, "ImportedAliasNames", true, "/r:" + library)
        IlVerifier.Verify(aliasConsumer, []string{library})
        Assert.Equal("17\n", fixture.Run(aliasConsumer))
        for source in[]string{
            "import WrongArity\nfunc Main() { var value slice[int32] }",
            "import WrongArity\nfunc Main() { var value array[int32] }",
            "import Constrained\nfunc Main() { var value slice[int32] }",
            "import Constrained\nfunc Main() { var value array[int32] }",
            `import ShadowOne
import ShadowTwo
func Main() { var value slice[int32] }`,
            `import ShadowOne
import ShadowTwo
func Main() { var value array[int32] }`,
            `import ShadowOne
import ShadowTwo
func Main() { let value = slice[int32]{} }`,
            `import ShadowOne
import ShadowTwo
func Main() { let value = array[int32]{} }`,
            "class slice[T, U] { }\nfunc Main() { var value slice[int32] }",
            "class array[T, U] { }\nfunc Main() { var value array[int32] }",
            "type slice = int32\nfunc Main() { var value slice[int32] }",
            "type array = int32\nfunc Main() { var value array[int32] }",
            "import slice = ShadowOne.slice\nfunc Main() { var value readonly slice[int32] }",
            "class slice[T] { }\nfunc Main() { var value readonly slice[int32] }"
        } {
            let (code, output) = fixture.TryCompile(
                "package ShadowFailures\n" + source,
                "ShadowFailures",
                true,
                "/r:" + library
            )
            Assert.True(code != 0, "Ordinary name was silently retargeted:\n" + source + "\n" + output)
            Assert.DoesNotContain("GS0600", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0005", output, StringComparison.Ordinal)
        }
    }

    @Fact
    func MemoryArrayNullableAndBoxedBoundariesKeepTheirExactRepresentation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package NativeBoundaries
import System
func Main() {
    let raw = array[int32]{1, 2, 3}
    let s = slice[int32].FromArray(raw)
    if s.TryGetArray(out var recovered) {
        recovered[0] = 7
    }
    Console.WriteLine(raw[0])
    if slice[int32].TryFromMemory(s.AsMemory(), out var memory) {
        memory[1] = 9
        Console.WriteLine(memory.Capacity)
    }
    Console.WriteLine(raw[1])
    let boxed object = s
    Console.WriteLine(boxed is array[int32])
    Console.WriteLine(boxed is slice[int32])
    let absent slice[int32]? = nil
    Console.WriteLine(absent?[0] == nil)
    let present slice[int32]? = s
    Console.WriteLine(present!![0])
    let readonlyPresent (readonly slice[int32])? = s.AsReadOnly()
    Console.WriteLine(readonlyPresent!![1])
    let nullable = slice[string?]{nil}
    Console.WriteLine(nullable == nullable)
    if slice[string?].TryFromMemory(nullable.AsMemory(), out var recoveredNullable) {
        Console.WriteLine(recoveredNullable[0] == nil)
    }
}`
        let dll = fixture.Compile(source, "NativeBoundaries", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
3
9
False
True
True
7
9
True
True
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("s[0] = await Task.FromResult(2)")
    @InlineData("s[0] += await Task.FromResult(2)")
    @InlineData("frames[0].Value = await Task.FromResult(2)")
    @InlineData("frames[0].Value += await Task.FromResult(2)")
    func SuspendedElementLocationsAreDiagnosed(statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package NativeSuspension
import System.Threading.Tasks
struct Frame { var Value int32 }
async func Run(s slice[int32], frames slice[Frame]) {` + "\n" + statement + "\n}"
        let (code, output) = fixture.TryCompile(source, "NativeSuspension", false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0602", StringComparison.Ordinal), output)
        Assert.Contains(".gs(5,", output, StringComparison.Ordinal)
    }

    @Fact
    func NestedElementWritesAndSegmentLocalBorrowsKeepTheOriginalLocation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package NativeBorrowing
import System
import System.Threading.Tasks
struct Frame { var Value int32 }
class Box { var Value int32 }
var frames = slice[Frame]{Frame{Value: 2}}
var boxes = slice[Box]{Box{Value: 1}}
var calls = 0
func IndexValue() int32 { calls++
    return 0
}
func Replace() int32 {
    frames = slice[Frame]{Frame{Value: 100}}
    return 7
}
async func LocalBorrow(s slice[int32]) int32 {
    var ref element = s[0]
    element = 4
    await Task.Delay(1)
    return s[0]
}
func Main() {
    let old = frames
    frames[IndexValue()].Value += Replace()
    Console.WriteLine(old[0].Value)
    Console.WriteLine(frames[0].Value)
    Console.WriteLine(calls)
    boxes[IndexValue()].Value += Replace()
    Console.WriteLine(boxes[0].Value)
    let readonlyBoxes = boxes.AsReadOnly()
    readonlyBoxes[IndexValue()].Value += 1
    Console.WriteLine(boxes[0].Value)
    Console.WriteLine(calls)
    let s = slice[int32]{1, 2}
    let part = s[1..]
    part.AsSpan()[0] = 9
    Console.WriteLine(s[1])
    Console.WriteLine(LocalBorrow(s).GetAwaiter().GetResult())
}
Main()`
        let dll = fixture.Compile(source, "NativeBorrowing", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`9
100
1
8
9
3
9
4
`, fixture.Run(dll))
    }

    @Fact
    func OfflineStereoSampleHasValueFramesSharedViewsAndZeroLoopAllocations() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = File.ReadAllText(
            Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "samples", "NativeSlices.gs")
            )
        )
        let dll = fixture.Compile(source, "NativeSlices", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`4
8
0
`, fixture.Run(dll))
    }

    @Fact
    func MissingRuntimeReportsActionableDiagnosticAtTheType() {
        using let references = ReferenceResolver.WithReferences([]string{typeof(object).Assembly.Location})
        const source = "package MissingNative\nfunc Use(value slice[int32]) { }"
        let tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(source)
        let compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation(references, tree)
        let diagnostic = Assert.Single(
            compilation.GlobalScope.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0600"
        )
        Assert.Contains("Gsharp.Runtime.Values", diagnostic.Message, StringComparison.Ordinal)
        Assert.Equal("slice[int32]", source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    @Fact
    func ForwardedDescriptorRefsHaveRoslynParity() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = fixture.CompileCSharp(`using Gsharp.Values;
public static class RefParity {
    public static ref Slice<int> Borrow(ref Slice<int> value) => ref value;
    public static ref readonly ReadOnlySlice<int> View(ref ReadOnlySlice<int> value) => ref value;
}`, "RefParity")
        AssertForwardingBodies(reference, "Borrow", "View")
        let verifierFailure = Assert.Throws[XunitException](() -> IlVerifier.Verify(reference))
        Assert.Contains("[ReturnPtrToStack]", verifierFailure.Message, StringComparison.Ordinal)
        Assert.Contains("2 Error(s)", verifierFailure.Message, StringComparison.Ordinal)
        IlVerifier.Verify(
            reference,
            ignoredErrorCodes: IlVerifier.KnownIssues.RefStruct,
            ignoredErrorScope: "(Borrow|View)$$"
        )
    }

    @Fact
    func GSharpAndCSharpUseIdenticalGenericAndRefoutMetadata() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "NativeApi.ref.dll")
        let api = fixture.Compile(`package NativeApi
public class Buffers {
    shared {
        public func Tail[T](s slice[T]) slice[T] { return s[1..] }
        public func View(s slice[int32]) readonly slice[int32] { return s.AsReadOnly() }
        public func First(s slice[int32]) ref int32 { return ref s[0] }
        public func Optional(s readonly slice[string?]?) readonly slice[string?]? { return s }
        public func Raw(s array[int32]) []int32 { return s }
    }
}`, "NativeApi", false, "/refout:" + reference)
        IlVerifier.Verify(api)
        let producer = EmittedFixture.Load(api)
        let apiType Type? = producer.GetType("NativeApi.Buffers", throwOnError: true)
        Assert.Equal(typeof(readonly slice[int32]), apiType!!.GetMethod("View")!!.ReturnType)
        Assert.Equal(typeof([]int32), apiType!!.GetMethod("Raw")!!.ReturnType)
        Assert.True(apiType!!.GetMethod("First")!!.ReturnType.IsByRef)
        Assert.Equal(typeof(Slice[_]), apiType!!.GetMethod("Tail")!!.ReturnType.GetGenericTypeDefinition())
        let nullable = NullabilityInfoContext().Create(apiType!!.GetMethod("Optional")!!.ReturnParameter)
        Assert.Equal(NullabilityState.Nullable, nullable.ReadState)
        Assert.Equal(typeof(string), nullable.GenericTypeArguments[0].Type)
        Assert.Equal(NullabilityState.Nullable, nullable.GenericTypeArguments[0].ReadState)
        let consumer = fixture.CompileCSharp(`using Gsharp.Values;
namespace NativeConsumer;
public static class Consumer
{
    public static int Run()
    {
        var owner = new[] { 1, 2, 3 };
        var slice = Slice<int>.FromArray(owner);
        NativeApi.Buffers.Tail(slice)[0] = 9;
        NativeApi.Buffers.First(slice) = 7;
        return owner[0] * 100 + NativeApi.Buffers.View(slice)[1] * 10 + owner[2];
    }
    public static Slice<int> Produce() => Slice<int>.FromArray(new[] { 3, 5, 7 });
    public static Slice<string?> NullableElements() => Slice<string?>.FromArray(new string?[] { null });
    public static ReadOnlySlice<string?>? Optional(ReadOnlySlice<string?>? value) => value;
}`, "consumer", reference)
        IlVerifier.Verify(consumer, []string{api})
        let pair = EmittedFixture.LoadTogether(api, consumer)
        Assert.Equal(793, pair[1].GetType("NativeConsumer.Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
        let gsConsumer = fixture.Compile(`package ImportedNative
import System
import NativeConsumer
let s = Consumer.Produce()
s[1..][0] = 11
Console.WriteLine(s[1])
let nullable slice[string?] = Consumer.NullableElements()
Console.WriteLine(nullable[0] == nil)
let named Gsharp.Values.Slice[string?] = nullable
Console.WriteLine(named[0] == nil)`, "gsconsumer", true, "/r:" + consumer, "/r:" + api)
        IlVerifier.Verify(gsConsumer, []string{consumer, api})
        Assert.Equal(`11
True
True
`, fixture.Run(gsConsumer))
    }

    internal class Fixture : IDisposable {
        init() {
            Directory = Path.Combine(
                Environment.CurrentDirectory,
                "out",
                "test-artifacts",
                "native-slices-" + Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(Directory)
        }

        prop Directory string {
            get;
        }

        func Compile(source string, name string, executable bool, extra ...string) string {
            let (code, output) = TryCompile(source, name, executable, extra)
            Assert.True(code == 0, output)
            return Path.Combine(Directory, name + ".dll")
        }

        func TryCompile(source string, name string, executable bool, extra ...string)(Code int32, Output string) {
            let sourceFile = Path.Combine(Directory, name + ".gs")
            File.WriteAllText(sourceFile, source)
            using let output = StringWriter()
            let stdout = Console.Out
            let stderr = Console.Error
            Console.SetOut(output)
            Console.SetError(output)
            try {
                let args = []string{
                    "/out:" + Path.Combine(Directory, name + ".dll"),
                    if executable {
                        "/target:exe"
                    } else {
                        "/target:library"
                    },
                    "/targetframework:net10.0",
                    sourceFile
                }
                    .Concat(extra).ToArray()
                return (Program.Main(args), output.ToString())
            } finally {
                Console.SetOut(stdout)
                Console.SetError(stderr)
            }
        }

        func CompileCSharp(source string, name string, extra ...string) string {
            return CompileCSharpCore(source, name, nil, extra)
        }

        func CompileCSharpWithReference(
            source string,
            name string,
            reference string,
            extra ...string
        ) string -> CompileCSharpCore(source, name, reference, extra)

        private func CompileCSharpCore(source string, name string, reference string?, extra ...string) string {
            let paths = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")))
                .Split(Path.PathSeparator)
                .Concat([]string{typeof(Slice[_]).Assembly.Location})
                .Concat(extra)
                .Distinct(StringComparer.Ordinal)
            let compilation = CSharpCompilation.Create(
                name,
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                paths.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let path = Path.Combine(Directory, name + ".dll")
            if reference != nil {
                using let implementation = File.Create(path)
                using let refStream = File.Create(reference)
                let result = compilation.Emit(
                    implementation,
                    metadataPEStream: refStream,
                    options: Microsoft.CodeAnalysis.Emit.EmitOptions(includePrivateMembers: false)
                )
                Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            } else {
                let result = compilation.Emit(path)
                Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            }
            return path
        }

        func Run(assembly string) string {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Directory
            }
            start.ArgumentList.Add(assembly)
            using let process Process? = Process.Start(start)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "native slice witness timed out")
            Assert.True(process!!.ExitCode == 0, stderr)
            return stdout.ReplaceLineEndings("\n")
        }

        func RunBytes(assembly string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Directory
            }
            start.ArgumentList.Add(assembly)
            using let process = Process.Start(start)!!
            let stderr = process.StandardError.ReadToEndAsync()
            using let stdout = MemoryStream()
            let readOutput = process.StandardOutput.BaseStream.CopyToAsync(stdout)
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("native slice byte witness timed out")
            }
            readOutput.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, stderr.GetAwaiter().GetResult())
            return stdout.ToArray()
        }

        func Dispose() -> Directory.Delete(Directory, recursive: true)
    }

    shared {
        func Programs() sequence[[]object] {
            yield[]object{`package NativePostfix
import System
func Main() {
    let values = slice[int32]{10}
    let previous = values[0]++
    Console.WriteLine(previous)
    Console.WriteLine(values[0])
}`, `10
11
`}
            yield[]object{`package NativeRawArrayConversions
import System
class array { var Value int32 }
class slice { var Value int32 }
func Main() {
    let arrays = []array{array{Value: 7}}
    let slices = []slice{slice{Value: 9}}
    let boxedArrays object = arrays
    let boxedSlices object = slices
    let recoveredArrays = []array(boxedArrays)
    let recoveredSlices = []slice(boxedSlices)
    Console.WriteLine(recoveredArrays[0].Value + recoveredSlices[0].Value)
}`, "16\n"}
            yield[]object{`package NativeSourceAliases
import System
type slice = int32
type array = int32
func Main() {
    let first slice = 1
    let second $slice = 2
    let third array = 3
    let fourth $array = 4
    Console.WriteLine(first + second + third + fourth)
}`, "10\n"}
            yield[]object{`package NativeNamePrecedence
import System
class slice[T] { var Value T }
class array[T] { var Value T }
func Main() {
    let first = slice[int32]{Value: 1}
    let second = $slice[int32]{Value: 2}
    let third = array[int32]{Value: 3}
    let fourth = array[int32]()
    fourth.Value = 4
    Console.WriteLine(first.Value)
    Console.WriteLine(second.Value)
    Console.WriteLine(third.Value)
    Console.WriteLine(fourth.Value)
    let native = Gsharp.Values.Slice[int32].Create(1, 2)
    native[0] = 5
    Console.WriteLine(native[0])
    let ro = Gsharp.Values.ReadOnlySlice[int32].FromArray([]int32{6})
    Console.WriteLine(ro[0])
}`, `1
2
3
4
5
6
`}
            yield[]object{`package NativeFunctionPrecedence
import System
func slice[T](value T) T { return value }
func array[T](value T) T { return value }
func Main() {
    Console.WriteLine(slice[int32](1))
    Console.WriteLine(array[int32](2))
    let slice = []int32{3, 4}
    let array = []int32{5, 6}
    Console.WriteLine(slice[1])
    Console.WriteLine(array[1])
    let $readonly = 7
    Console.WriteLine($readonly)
}`, `1
2
4
6
7
`}
            yield[]object{`package NativeBuffers
import System
import Gsharp.Values
struct Frame {
    var Left float64
    var Right float64
}
func Tail[T](s slice[T]) slice[T] { return s[1..] }
func First[T](s slice[T]) ref T { return ref s[0] }
func Same[T](left slice[T], right slice[T]) bool { return left == right }
func SameNullable[T](left slice[T]?, right slice[T]?) bool { return left == right }
func Read[T](value slice[T]) readonly slice[T] { return value }
func ReadNullable[T](value slice[T]?) readonly slice[T]? { return value }
func Repeat[T](value T) slice[T] {
    let start = slice[T].Create(0, 2)
    return start.Append(value).Append(value)
}
func Main() {
var s = slice[int32]{1, 2, 3}
let tail = Tail(s)
tail[0] = 9
var ref saved = First(s)
s = s.Append(4)
saved = 7
Console.WriteLine(tail[0])
Console.WriteLine(s[0])
var frames = slice[Frame]{Frame{Left: 1.0, Right: 2.0}, Frame{Left: 3.0, Right: 4.0}}
frames[0].Left *= 2.0
var copy = frames[0]
copy.Left = 99.0
Console.WriteLine(frames[0].Left)
Tail(frames)[0].Right = 8.0
Console.WriteLine(frames[1].Right)
let ro readonly slice[Frame] = frames.AsReadOnly()
Console.WriteLine(ro[^1].Right)
let raw = array[int32]{1, 2, 3}
var copied = raw[1..]
copied[0] = 99
Console.WriteLine(raw[1])
Console.WriteLine(Repeat(Frame{Left: 12.0, Right: 13.0})[1].Left)
Console.WriteLine(Same(frames, frames))
Console.WriteLine(SameNullable[Frame](frames, frames))
Console.WriteLine(Read(frames)[0].Left)
Console.WriteLine(ReadNullable[Frame](frames)!![0].Left)
}`, `9
1
2
8
8
2
12
True
True
2
2
`}
            yield[]object{`package NativeRanges
import System
import Gsharp.Values
var s = slice[int32].Create(2, 6)
s[0] = 1
s[1] = 2
let sibling = s
s = s.Append(3)
Console.WriteLine(sibling.Length)
Console.WriteLine(sibling[0..3][2])
let limited = s.Slice(0, 3, 3)
var grown = limited.Append(4)
grown[0] = 99
Console.WriteLine(s[0])
let zero = s[1..1]
Console.WriteLine(zero.Capacity)
Console.WriteLine(zero[0..2][1])
let selected = 1..3
Console.WriteLine(s[selected][1])
let ro = readonly slice[int32]{8, 9}
Console.WriteLine(ro[1..][0])
var empty slice[int32]
var readEmpty readonly slice[int32]
let absent slice[int32]? = nil
Console.WriteLine(empty.Length)
Console.WriteLine(readEmpty.Capacity)
Console.WriteLine(absent == nil)
let elements = slice[string?]{nil, "x"}
Console.WriteLine(elements[0] == nil)`, `2
3
1
5
3
3
9
0
0
True
True
`}
            yield[]object{`package NativePatterns
import System
var s = slice[int32]{1, 2, 3}
if s is [1, ..rest] {
    rest[0] = 9
    Console.WriteLine(rest.Length)
}
Console.WriteLine(s[1])
let saved = s
for value in s {
    Console.WriteLine(value)
    saved[2] = 7
    s = slice[int32]{99}
}`, `2
9
1
9
7
`}
            yield[]object{`package NativeModifiers
import System
import System.Collections.Generic
import System.Threading.Tasks
class readonlySlice { }
struct Counter {
    var Value int32
    func Increment() { this.Value++ }
}
class Holder[T] {
    var Items slice[T]
    var View readonly slice[T]
}
func Borrow(ref value slice[int32]) ref readonly slice[int32] { return ref value }
func BorrowView(ref value readonly slice[int32]) ref (readonly slice[int32]) { return ref value }
func ReadBorrowView(ref value readonly slice[int32]) ref readonly (readonly slice[int32]) { return ref value }
func Pair(value readonly slice[int32]) (readonly slice[int32], slice[int32]?) {
    let absent slice[int32]? = nil
    return (value, absent)
}
async func Echo[T](value slice[T]) slice[T] {
    await Task.Delay(1)
    return value
}
func Main() {
    var s = slice[int32]{1, 2}
    var ro readonly slice[int32] = s
    let lists = List[readonly slice[int32]]()
    let nestedLists = List[[]readonly slice[int32]]()
    Console.WriteLine(nestedLists.Count)
    lists.Add(ro)
    Console.WriteLine(lists[0][0])
    Console.WriteLine(Pair(ro).Item1[1])
    let ref readonly descriptor = Borrow(ref s)
    descriptor[0] = 8
    Console.WriteLine(s[0])
    var ref readDescriptor = BorrowView(ref ro)
    readDescriptor = readonly slice[int32]{9}
    Console.WriteLine(ro[0])
    let observed = ReadBorrowView(ref ro)
    Console.WriteLine(observed[0])
    let h = Holder[int32]()
    h.Items = s
    Console.WriteLine(h.Items[0])
    let counters = slice[Counter]{Counter{Value: 2}}
    let readonlyCounters = counters.AsReadOnly()
    readonlyCounters[0].Increment()
    Console.WriteLine(counters[0].Value)
    counters[0].Increment()
    Console.WriteLine(counters[0].Value)
    let captured = func() int32 { return s[0] }
    s = slice[int32]{10}
    Console.WriteLine(captured())
    Console.WriteLine(Echo(s).GetAwaiter().GetResult()[0])
    Console.WriteLine(s == s)
    Console.WriteLine(s == s.Clone())
    var nested []slice[int32]
    Console.WriteLine(nested.Length)
}`, `0
1
2
8
9
9
8
2
3
10
10
True
False
0
`}
            yield[]object{`package NativeOrder
import System
var s = slice[int32]{1, 2}
var trace = ""
func Receiver() slice[int32] {
    trace += "R"
    return s
}
func Lo() int32 {
    trace += "L"
    return -1
}
func Hi() int32 {
    trace += "H"
    return 2
}
func IndexValue() int32 {
    trace += "I"
    s = slice[int32]{20, 30}
    return 0
}
func Value() int32 {
    trace += "V"
    return 9
}
func ChangeForAppend() int32 {
    s = slice[int32]{50}
    return 9
}
func ChangeUpper() int32 {
    s = slice[int32]{60}
    return 2
}
try { let bad = Receiver()[Lo()..Hi()] }
catch (ex ArgumentOutOfRangeException) { trace += "E" }
Console.WriteLine(trace)
trace = ""
let old = s
s[IndexValue()] = Value()
Console.WriteLine(trace)
Console.WriteLine(old[0])
Console.WriteLine(s[0])
trace = ""
s[0] += Value()
Console.WriteLine(s[0])
try { s[100] = Value() }
catch (ex IndexOutOfRangeException) { trace += "E" }
Console.WriteLine(trace)
try { let bad = s[^-1] }
catch (ex IndexOutOfRangeException) { Console.WriteLine("index") }
let appended = s.Append(ChangeForAppend())
Console.WriteLine(appended.Length)
Console.WriteLine(appended[0])
s = slice[int32]{3, 4}
let subslice = s.Subslice(0, ChangeUpper())
Console.WriteLine(subslice[0])
Console.WriteLine(s[0])`, `RLHE
IV
9
20
29
VE
index
3
29
3
60
`}
        }

        private func AssertForwardingBodies(path string, names ...string) {
            let assembly = EmittedFixture.Load(path)
            for name in names {
                let method = Assert.Single(
                    assembly.GetTypes().SelectMany(
                        func (type Type) IEnumerable[MethodInfo] {
                            return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                        }
                    ),
                    (method MethodInfo) -> method.Name == name
                )
                Assert.Equal([]uint8{0x02, 0x2a}, method.GetMethodBody()!!.GetILAsByteArray())
                Assert.True(method.ReturnType.IsByRef)
                Assert.Equal(method.ReturnType, Assert.Single(method.GetParameters()).ParameterType)
                Assert.Empty(method.GetMethodBody()!!.LocalVariables)
            }
        }
    }
}
