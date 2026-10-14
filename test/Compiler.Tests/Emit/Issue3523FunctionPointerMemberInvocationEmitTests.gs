// <copyright file="Issue3523FunctionPointerMemberInvocationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// Issue #3523 end-to-end coverage for function-pointer-valued member calls.
open class Issue3523FunctionPointerMemberInvocationEmitTests {
    @Fact
    func ExactUnmanagedFieldRepro_BuildsAndContainsCalli_WithoutExecution() {
        const source = `package FindingFunctionPointerFieldInvocation

unsafe struct Dispatch {
    var Apply unmanaged[Cdecl] (int32) -> int32
}

unsafe func Main() int32 {
    let dispatch = Dispatch{}
    return dispatch.Apply(41)
}`
        let outputDirectory = Compile(source, out var outputPath)
        try {
            VerifyFunctionPointerAssembly(outputPath)
            Assert.True(ContainsCalli(outputPath), "expected field invocation to emit calli")
        } finally {
            DeleteDirectory(outputDirectory)
        }
    }

    @Fact
    func ManagedFieldPropertyIndexerConditionalStaticAndRefCalls_Run() {
        const source = `package Issue3523Managed
import System

class Tracker {
    shared {
        var OwnerCalls int32
    }
}

unsafe func increment(value int32) int32 -> value + 1

unsafe struct Dispatch {
    var Apply *func(int32) int32
    prop Handler *func(int32) int32 -> Apply

    func InvokeField(value int32) int32 -> Apply(value)
    func InvokeProperty(value int32) int32 -> Handler(value)

    shared {
        var SharedApply *func(int32) int32
        prop SharedHandler *func(int32) int32 -> SharedApply
        func InvokeShared(value int32) int32 -> SharedApply(value)
    }
}

unsafe class Box {
    let Apply *func(int32) int32
    init(apply *func(int32) int32) {
        Apply = apply
    }
}

unsafe func makeDispatch() Dispatch {
    Tracker.OwnerCalls += 1
    Console.Write("R")
    return Dispatch{Apply: &increment}
}

func nextArgument() int32 {
    Console.Write("A")
    return 41
}

unsafe func invokeRef(ref pointer *func(int32) int32, value int32) int32 {
    return pointer(value)
}

unsafe func Main() {
    let dispatch = Dispatch{Apply: &increment}
    Dispatch.SharedApply = &increment

    Console.WriteLine(dispatch.Apply(41))
    Console.WriteLine(dispatch.Handler(40))
    Console.WriteLine(dispatch.InvokeField(39))
    Console.WriteLine(dispatch.InvokeProperty(38))
    Console.WriteLine(Dispatch.SharedApply(37))
    Console.WriteLine(Dispatch.SharedHandler(36))
    Console.WriteLine(Dispatch.InvokeShared(35))

    let pointers = []*func(int32) int32{&increment}
    Console.WriteLine(pointers[0](34))
    Console.WriteLine((true ? dispatch.Apply : dispatch.Handler)(33))
    Console.WriteLine((dispatch.Apply)(32))

    var pointer = &increment
    Console.WriteLine(invokeRef(ref pointer, 31))

    let present Box? = Box(&increment)
    let absent Box? = nil
    Console.WriteLine(present?.Apply(30))
    Console.WriteLine(absent?.Apply(30) == nil)

    Console.WriteLine(makeDispatch().Apply(nextArgument()))
    Console.WriteLine(Tracker.OwnerCalls)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "42",
                "41",
                "40",
                "39",
                "38",
                "37",
                "36",
                "35",
                "34",
                "33",
                "32",
                "31",
                "True",
                "RA42",
                "1",
                string.Empty
            ),
            output
        )
    }

    @Fact
    func UnmanagedCdeclField_RealNativeAddress_Runs() {
        if RuntimeInformation.IsOSPlatform(OSPlatform.Windows) {
            return
        }
        let defaultSymbolHandle = if RuntimeInformation.IsOSPlatform(OSPlatform.OSX) {
            "-2"
        } else {
            "0"
        }
        let source = (`package Issue3523Unmanaged
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] (int32) -> int32;

unsafe struct NativeDispatch {
    var Apply unmanaged[Cdecl] (int32) -> int32
}

unsafe func Main() {
    let dispatch = NativeDispatch{
        Apply: native_dlsym(nint(` + "$defaultSymbolHandle" + `), "abs")
    }
    Console.WriteLine(dispatch.Apply(-41))
}`)
        Assert.Equal("41${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericStructClassAndMethodPointerSignatures_RunClosed() {
        const source = `package Issue3523GenericOwners
import System

unsafe func identity(value int32) int32 -> value
unsafe func choose[T](pointer *func(T) T) *func(T) T -> pointer

unsafe struct Dispatch[T] {
    var Apply *func(T) T
    prop Handler *func(T) T -> Apply
    shared { var SharedApply *func(T) T }
}

unsafe class Holder[T] {
    let Apply *func(T) T
    init(apply *func(T) T) { Apply = apply }
}

unsafe func Main() {
    let dispatch = Dispatch[int32]{Apply: &identity}
    Dispatch[int32].SharedApply = &identity
    let holder = Holder[int32](&identity)
    let selected *func(int32) int32 = choose[int32](&identity)

    Console.WriteLine(dispatch.Apply(41))
    Console.WriteLine(dispatch.Handler(42))
    Console.WriteLine(Dispatch[int32].SharedApply(43))
    Console.WriteLine(holder.Apply(44))
    Console.WriteLine(selected(45))
}`
        let output = CompileAndRun(source, AssertCalliSignaturesClosedInt32)
        Assert.Equal(string.Join(Environment.NewLine, "41", "42", "43", "44", "45", string.Empty), output)
    }

    @Fact
    func GenericInterfaceInstanceAndStaticCalls_EmitClosedCalli() {
        const source = `package Issue3523GenericInterface

interface IDispatch[T] {
    prop Apply unmanaged[Cdecl] (T) -> T { get }
    shared { var SharedApply unmanaged[Cdecl] (T) -> T }
}

struct Dispatch[T] : IDispatch[T] {
    var Pointer unmanaged[Cdecl] (T) -> T
    prop Apply unmanaged[Cdecl] (T) -> T -> Pointer
}

func invoke(dispatch IDispatch[int32]) int32 {
    let first int32 = dispatch.Apply(41)
    let second int32 = IDispatch[int32].SharedApply(42)
    return first + second
}

func Main() { }`
        let outputDirectory = Compile(source, out var outputPath)
        try {
            VerifyFunctionPointerAssembly(outputPath)
            Assert.True(CountCalli(outputPath) >= 2, "expected closed generic interface instance/static calli sites")
            AssertCalliSignaturesClosedInt32(outputPath)
        } finally {
            DeleteDirectory(outputDirectory)
        }
    }

    @Fact
    func CompositeGenericPointerSignatures_RunAndEmitClosedCalli() {
        const source = `package Issue3523CompositePointers
import System
import System.Linq

unsafe func combine(
    values map[string,int32],
    pair (int32, string),
    items sequence[int32],
    asyncItems async sequence[int32]) int32 {
    return values["x"] + pair.Item1 + items.First()
}

async func getAsyncItems() async sequence[int32] { yield 4 }

unsafe struct Dispatch[T] {
    var Apply *func(map[string,T], (T, string), sequence[T], async sequence[T]) T
}

interface IDispatch[T] {
    prop Apply unmanaged[Cdecl] (map[string,T], (T, string), sequence[T], async sequence[T]) -> T { get }
    shared {
        var SharedApply unmanaged[Cdecl] (map[string,T], (T, string), sequence[T], async sequence[T]) -> T
    }
}

func invokeInterface(dispatch IDispatch[int32]) int32 {
    let values = map[string,int32]{"x": 1}
    let pair = (2, "two")
    let items = []int32{3}
    let asyncItems = getAsyncItems()
    return dispatch.Apply(values, pair, items, asyncItems)
        + IDispatch[int32].SharedApply(values, pair, items, asyncItems)
}

unsafe func Main() {
    let dispatch = Dispatch[int32]{Apply: &combine}
    Console.WriteLine(dispatch.Apply(
        map[string,int32]{"x": 1},
        (2, "two"),
        []int32{3},
        getAsyncItems()))
}`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source, AssertCalliSignaturesClosedInt32))
    }

    @Fact
    func GenericInterfaceMemberSubstitution_DoesNotEmitSmartCast() {
        const source = `package Issue3523GenericInterfaceMembers
import System

interface IBox[T] {
    prop Value T { get; set; }
    shared { var Shared T }
}

interface IDerivedBox[T] : IBox[T] { }

class IntBox : IDerivedBox[int32] {
    prop Value int32 { get; set; }
}

open class Animal {
    func Speak() string -> "animal"
}

class Dog : Animal {
    func Bark() string -> "woof"
}

class SmartBox {
    prop Pet Animal { get; init; }
}

func GetBox(box IDerivedBox[int32]) IDerivedBox[int32] -> box

func Set(box IDerivedBox[int32]) {
    box.Value = 1
    GetBox(box).Value += 2
}

func Main() {
    let box IDerivedBox[int32] = IntBox()
    Set(box)
    Console.WriteLine(box.Value)
    IBox[int32].Shared = 4
    IBox[int32].Shared += 1
    Console.WriteLine(IBox[int32].Shared)

    let smart = SmartBox() { Pet = Dog() }
    if smart.Pet is Dog {
        Console.WriteLine(smart.Pet.Bark())
    }
}`
        Assert.Equal(
            string.Join(Environment.NewLine, "3", "5", "woof", string.Empty),
            CompileAndRun(source, AssertNoBoxOrUnboxInstructions)
        )
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private func CompileAndRun(source string, inspectAssembly((string) -> void)? = nil) string {
            let outputDirectory = Compile(source, out var outputPath)
            try {
                VerifyFunctionPointerAssembly(outputPath)
                inspectAssembly?(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDirectory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let standardOutput = process.StandardOutput.ReadToEnd()
                let standardError = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$standardOutput" + `
stderr:
` + "$standardError"))
                return standardOutput.ReplaceLineEndings(Environment.NewLine)
            } finally {
                DeleteDirectory(outputDirectory)
            }
        }

        private func Compile(source string, out outputPath string) string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3523", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outputDirectory)
            let sourcePath = Path.Combine(outputDirectory, "Program.gs")
            outputPath = Path.Combine(outputDirectory, "Issue3523.dll")
            File.WriteAllText(sourcePath, source)
            using let standardOut = StringWriter()
            using let standardError = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOut)
            Console.SetError(standardError)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
            return outputDirectory
        }

        private func VerifyFunctionPointerAssembly(outputPath string) {
            try {
                IlVerifier.Verify(outputPath, nil, UnsafeIlVerifyIgnored)
            } catch (exception Exception) when exception.Message.Contains(
                "ImportCalli not implemented",
                StringComparison.Ordinal
            ) { }
        }

        private func ContainsCalli(outputPath string) bool -> CountCalli(outputPath) != 0

        private func CountCalli(outputPath string) int32 {
            var count = 0
            using let peReader = PEReader(File.OpenRead(outputPath))
            let metadata = peReader.GetMetadataReader()
            for methodHandle in metadata.MethodDefinitions {
                let method = metadata.GetMethodDefinition(methodHandle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
                let instructions = IlInstructionReader.Read(body.GetILBytes() ?? Array.Empty[uint8]())
                count += instructions.Count((instruction IlInstruction) -> instruction.OpCode == OpCodes.Calli)
            }
            return count
        }

        private func AssertCalliSignaturesClosedInt32(outputPath string) {
            using let peReader = PEReader(File.OpenRead(outputPath))
            let metadata = peReader.GetMetadataReader()
            var calliCount = 0
            for methodHandle in metadata.MethodDefinitions {
                let method = metadata.GetMethodDefinition(methodHandle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
                let il = body.GetILBytes() ?? Array.Empty[uint8]()
                for instruction in IlInstructionReader.Read(il) {
                    if instruction.OpCode != OpCodes.Calli {
                        continue
                    }
                    calliCount++
                    let token = BitConverter.ToInt32(il, instruction.Offset + 1)
                    let signatureHandle = MetadataTokens.StandaloneSignatureHandle(token & 0x00FFFFFF)
                    let signature = metadata.GetStandaloneSignature(signatureHandle)
                    let blob = metadata.GetBlobBytes(signature.Signature)
                    Assert.DoesNotContain(uint8(SignatureTypeCode.GenericTypeParameter), blob)
                    Assert.DoesNotContain(uint8(SignatureTypeCode.GenericMethodParameter), blob)
                    Assert.True(
                        blob.Count((value uint8) -> value == uint8(SignatureTypeCode.Int32)) >= 2,
                        "expected closed int32 parameter/return signature: ${Convert.ToHexString(blob)}"
                    )
                }
            }
            Assert.True(calliCount > 0, "expected at least one calli signature")
        }

        private func AssertNoBoxOrUnboxInstructions(outputPath string) {
            using let peReader = PEReader(File.OpenRead(outputPath))
            let metadata = peReader.GetMetadataReader()
            for methodHandle in metadata.MethodDefinitions {
                let method = metadata.GetMethodDefinition(methodHandle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
                let instructions = IlInstructionReader.Read(body.GetILBytes() ?? Array.Empty[uint8]())
                Assert.DoesNotContain(
                    instructions,
                    (instruction IlInstruction) -> instruction.OpCode == OpCodes.Box ||
                        instruction.OpCode == OpCodes.Unbox ||
                        instruction.OpCode == OpCodes.Unbox_Any
                )
            }
        }

        private func DeleteDirectory(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch { }
        }
    }
}
