// <copyright file="Issue4938FunctionPointerCastEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #4938: raw function-pointer dispatch through an address loaded at
/// run time (`NativeLibrary.GetExport`, `GetProcAddress`,
/// `vkGetInstanceProcAddr`).
///
/// - `cast[unmanaged[CC] () -> R](address)` did not parse (the generic-call
///   scanner had no function-pointer branch), so it could not be written.
/// - `address as (unmanaged[CC] () -> R)?`, `x is unmanaged[…]` and
///   `case f is unmanaged[…]` compiled but always failed at run time since
///   issue #4685 (v0.4.1270 and every 0.5.x): the type-test opcodes were given
///   the FNPTR TypeSpec, which no boxed value is an instance of, instead of
///   the function pointer's runtime projection `System.IntPtr` that 0.4.1150
///   used. These tests call a real native export through every spelling and
///   pin the opcode tokens.
open class Issue4938FunctionPointerCastEmitTests {
    @Fact
    func NativeExport_IsCallable_Through_Cast() {
        let (library, export, convention) = NativeProcessIdExport()
        let source = (`import System
import System.Runtime.InteropServices

unsafe func castCall(address nint) int32 {
    let fn = cast[unmanaged[CC] () -> int32](address)
    return fn()
}

unsafe func castWithSignature(address nint) unmanaged[CC] (nint, *uint8) -> *void {
    return cast[unmanaged[CC] (nint, *uint8) -> *void](address)
}

unsafe func run() {
    let address = NativeLibrary.GetExport(NativeLibrary.Load("LIBRARY"), "EXPORT")
    Console.WriteLine(castCall(address) == Environment.ProcessId)
    Console.WriteLine(nint(castWithSignature(address)) == address)
}

run()`).Replace("CC", convention).Replace("LIBRARY", library).Replace("EXPORT", export)
        let result = CompileInspectAndRun(source, "castCall", "castWithSignature")
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", result.Output)
        // `cast[T]` from `nint` is a pure reinterpretation: no type test.
        for method in[]string{"castCall", "castWithSignature"} {
            let il = IlInstructionReader.Read(result.MethodIl[method])
            Assert.NotEmpty(il)
            Assert.DoesNotContain(il, (instruction IlInstruction) -> IsTypeTestOpCode(instruction.OpCode))
        }
    }

    @Fact
    func NativeExport_As_Is_And_Switch_Test_The_IntPtr_Projection() {
        let (library, export, convention) = NativeProcessIdExport()
        let source = (`import System
import System.Runtime.InteropServices

unsafe func asCall(address nint) int32 {
    let fn = address as (unmanaged[CC] () -> int32)?
    if fn == nil {
        return -1
    }
    return fn!!()
}

unsafe func asFromNuint(address nuint) bool -> (address as (unmanaged[CC] () -> int32)?) == nil

unsafe func isTest(boxed object) bool -> boxed is unmanaged[CC] () -> int32

unsafe func switchCall(boxed object) int32 {
    switch boxed {
        case fn is unmanaged[CC] () -> int32 {
            return fn()
        }
        default {
            return -2
        }
    }
}

unsafe func boxTest(fp unmanaged[CC] () -> int32) bool -> (fp as object?) is nint

unsafe func run() {
    let address = NativeLibrary.GetExport(NativeLibrary.Load("LIBRARY"), "EXPORT")
    let pid = Environment.ProcessId
    Console.WriteLine(asCall(address) == pid)
    Console.WriteLine(asFromNuint(nuint(address)))
    let boxed object = address
    Console.WriteLine(isTest(boxed))
    Console.WriteLine(isTest("not an address"))
    Console.WriteLine(switchCall(boxed) == pid)
    Console.WriteLine(switchCall("not an address"))
    Console.WriteLine(boxTest(nil))
}

run()`).Replace("CC", convention).Replace("LIBRARY", library).Replace("EXPORT", export)
        let result = CompileInspectAndRun(source, "asCall", "isTest", "switchCall", "boxTest")
        // ADR-0095 amendment (#4938): the test is against System.IntPtr, so a
        // `nint` operand always matches and a `nuint` (boxed UIntPtr) never
        // does.
        Assert.Equal(
            string.Join(Environment.NewLine, "True", "True", "True", "False", "True", "-2", "True") +
                Environment.NewLine,
            result.Output
        )
        // Each testing spelling tests System.IntPtr, and no runtime-type
        // opcode names a FNPTR TypeSpec.
        for method in[]string{"asCall", "isTest", "switchCall", "boxTest"} {
            let il = result.MethodIl[method]
            let tokens = IlInstructionReader
                .Read(il)
                .Where((instruction IlInstruction) -> IsTypeTestOpCode(instruction.OpCode))
                .ToArray()
            Assert.Contains(
                tokens,
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Isinst &&
                    DescribeTypeToken(result.Metadata, TypeOperand(il, instruction), out var _) == "System.IntPtr"
            )
            for instruction in tokens {
                // `box` / `unbox.any` of the `(unmanaged…)?` result name
                // `Nullable<IntPtr>` (a GENERICINST TypeSpec) and `as object?`
                // tests `System.Object`; no opcode may name the FNPTR type.
                let _ = DescribeTypeToken(result.Metadata, TypeOperand(il, instruction), out var head)
                Assert.NotEqual(SignatureTypeCode.FunctionPointer, head)
            }
        }
    }

    @Fact
    func FunctionPointer_Array_Element_Keeps_Its_FNPTR_TypeSpec() {
        // Issue #4685 non-regression: array-element opcodes still name the
        // exact FNPTR element so `newarr` creates the `method …*[]` the
        // signature declares, while type tests use IntPtr.
        const source = `import System

unsafe func makeArray() [](unmanaged[Cdecl] () -> int32) {
    return [2](unmanaged[Cdecl] () -> int32){}
}

unsafe func run() {
    let items = makeArray()
    Console.WriteLine(items.Length)
    Console.WriteLine(items[0] == nil)
}

run()`
        let result = CompileInspectAndRun(source, "makeArray")
        Assert.Equal("2${Environment.NewLine}True${Environment.NewLine}", result.Output)
        let il = result.MethodIl["makeArray"]
        let newarr = Assert.Single(
            IlInstructionReader.Read(il),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Newarr
        )
        let description = DescribeTypeToken(result.Metadata, TypeOperand(il, newarr), out var signatureHead)
        Assert.Equal("TypeSpec", description)
        Assert.Equal(SignatureTypeCode.FunctionPointer, signatureHead)
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        /// A parameterless native export that returns the current process id,
        /// with the convention its platform ABI uses.
        private func NativeProcessIdExport()(Library string, Export string, Convention string) {
            if OperatingSystem.IsWindows() {
                return ("kernel32.dll", "GetCurrentProcessId", "Stdcall")
            }
            if OperatingSystem.IsMacOS() {
                return ("/usr/lib/libSystem.B.dylib", "getpid", "Cdecl")
            }
            return ("libc.so.6", "getpid", "Cdecl")
        }

        private func IsTypeTestOpCode(opcode OpCode) bool -> opcode == OpCodes.Isinst ||
            opcode == OpCodes.Castclass ||
            opcode == OpCodes.Box ||
            opcode == OpCodes.Unbox_Any

        /// The 4-byte `InlineType` operand that follows the opcode.
        private func TypeOperand(il[]uint8, instruction IlInstruction) int32 {
            Assert.Equal(OperandType.InlineType, instruction.OpCode.OperandType)
            return BitConverter.ToInt32(il, instruction.Offset + instruction.OpCode.Size)
        }

        /// Names a type token: `Namespace.Name` for a TypeRef, `TypeSpec`
        /// for a TypeSpec (whose leading signature code is returned).
        private func DescribeTypeToken(
            metadata MetadataReader,
            token int32,
            out signatureHead SignatureTypeCode
        ) string {
            signatureHead = SignatureTypeCode.Invalid
            let handle = MetadataTokens.EntityHandle(token)
            if handle.Kind == HandleKind.TypeReference {
                let reference = metadata.GetTypeReference(TypeReferenceHandle(handle))
                return metadata.GetString(reference.Namespace) + "." + metadata.GetString(reference.Name)
            }
            if handle.Kind == HandleKind.TypeSpecification {
                let specification = metadata.GetTypeSpecification(TypeSpecificationHandle(handle))
                var blob = metadata.GetBlobReader(specification.Signature)
                signatureHead = blob.ReadSignatureTypeCode()
                return "TypeSpec"
            }
            return handle.Kind.ToString()
        }

        private func CompileInspectAndRun(source string, methods ...string)(
            Output string,
            MethodIl IReadOnlyDictionary[string, []uint8],
            Metadata MetadataReader
        ) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4938FunctionPointerCastEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue4938.dll")
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
                Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                // Read the assembly into memory so the metadata outlives the
                // output directory.
                let image = ImmutableArrayBytes(File.ReadAllBytes(outputPath))
                let peReader = PEReader(image)
                let metadata = peReader.GetMetadataReader()
                let methodIl = Dictionary[string, []uint8](StringComparer.Ordinal)
                for name in methods {
                    methodIl[name] = ReadMethodIl(peReader, metadata, name)
                }
                // Unsafe code is unverifiable by design; tolerate the inherent
                // unsafety codes and the verifier's missing `calli` support,
                // and still gate on every other verification error.
                try {
                    IlVerifier.Verify(outputPath, nil, UnsafeIlVerifyIgnored)
                } catch (ex Exception) when ex.Message.Contains(
                    "ImportCalli not implemented",
                    StringComparison.Ordinal
                ) {
                    // Known dotnet-ilverify limitation for `calli`.

                }
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
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`sample exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (stdout.ReplaceLineEndings(Environment.NewLine), methodIl, metadata)
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }

        private func ImmutableArrayBytes(bytes[]uint8) System.Collections.Immutable.ImmutableArray[uint8] ->
        System.Collections.Immutable.ImmutableArray.Create(bytes)

        private func ReadMethodIl(peReader PEReader, metadata MetadataReader, methodName string)[]uint8 {
            for methodHandle in metadata.MethodDefinitions {
                let method = metadata.GetMethodDefinition(methodHandle)
                if metadata.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0 {
                    continue
                }
                return peReader.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? Array.Empty[uint8]()
            }
            throw InvalidOperationException("Method '$methodName' was not found.")
        }
    }
}
