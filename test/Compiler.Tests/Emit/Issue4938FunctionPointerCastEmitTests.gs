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
import Xunit.Sdk

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
                    result.TypeTokens[TypeOperand(il, instruction)] == "System.IntPtr"
            )
            for instruction in tokens {
                // `box` / `unbox.any` of the `(unmanaged…)?` result name
                // `Nullable<IntPtr>` (a GENERICINST TypeSpec) and `as object?`
                // tests `System.Object`; no opcode may name the FNPTR type.
                Assert.NotEqual(FunctionPointerTypeSpec, result.TypeTokens[TypeOperand(il, instruction)])
            }
        }
    }

    @Fact
    func FunctionPointer_Identity_Opcodes_Keep_The_FNPTR_TypeSpec() {
        // Opcodes that name a type's identity keep the exact FNPTR type while
        // type tests use IntPtr: `newarr` creates the `method …*[]` the
        // signature declares (issue #4685), and `typeof` reflects a
        // function-pointer Type, as in C# and 0.5.x.
        const source = `import System

unsafe func makeArray() [](unmanaged[Cdecl] () -> int32) {
    return [2](unmanaged[Cdecl] () -> int32){}
}

unsafe func typeOfPointer() Type -> typeof(unmanaged[Cdecl] () -> int32)

unsafe func run() {
    let items = makeArray()
    Console.WriteLine(items.Length)
    Console.WriteLine(items[0] == nil)
    Console.WriteLine(typeOfPointer().IsFunctionPointer)
}

run()`
        let result = CompileInspectAndRun(source, "makeArray", "typeOfPointer")
        Assert.Equal(string.Join(Environment.NewLine, "2", "True", "True") + Environment.NewLine, result.Output)
        let arrayIl = result.MethodIl["makeArray"]
        let newarr = Assert.Single(
            IlInstructionReader.Read(arrayIl),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Newarr
        )
        Assert.Equal(FunctionPointerTypeSpec, result.TypeTokens[TypeOperand(arrayIl, newarr)])
        let typeOfIl = result.MethodIl["typeOfPointer"]
        let ldtoken = Assert.Single(
            IlInstructionReader.Read(typeOfIl),
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldtoken
        )
        Assert.Equal(FunctionPointerTypeSpec, result.TypeTokens[TypeOperand(typeOfIl, ldtoken)])
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

        private const FunctionPointerTypeSpec string = "TypeSpec FunctionPointer"

        /// The 4-byte `InlineType` / `InlineTok` operand that follows the
        /// opcode.
        private func TypeOperand(il[]uint8, instruction IlInstruction) int32 {
            Assert.True(
                instruction
                    .OpCode
                    .OperandType == OperandType.InlineType ||
                    instruction
                    .OpCode
                    .OperandType == OperandType.InlineTok
            )
            return BitConverter.ToInt32(il, instruction.Offset + instruction.OpCode.Size)
        }

        /// Names a type token: `Namespace.Name` for a TypeRef, and
        /// `TypeSpec <leading signature code>` for a TypeSpec.
        private func DescribeTypeToken(metadata MetadataReader, token int32) string {
            let handle = MetadataTokens.EntityHandle(token)
            if handle.Kind == HandleKind.TypeReference {
                let reference = metadata.GetTypeReference(TypeReferenceHandle(handle))
                return metadata.GetString(reference.Namespace) + "." + metadata.GetString(reference.Name)
            }
            if handle.Kind == HandleKind.TypeSpecification {
                let specification = metadata.GetTypeSpecification(TypeSpecificationHandle(handle))
                var blob = metadata.GetBlobReader(specification.Signature)
                return "TypeSpec " + blob.ReadSignatureTypeCode().ToString()
            }
            return handle.Kind.ToString()
        }

        /// ilverify does not implement `calli` and reports it as an
        /// uncategorised error, which `-g` cannot ignore. Accept a failure
        /// only when every reported error is that one.
        private func OnlyUnsupportedCalli(message string) bool {
            let errors = message
                .Split('\n')
                .Select((line string) -> line.Trim())
                .Where((line string) -> line.StartsWith("[IL]: Error", StringComparison.Ordinal))
                .ToArray()
            return errors.Length > 0 && errors.All(
                (line string) -> line.EndsWith("ImportCalli not implemented", StringComparison.Ordinal)
            )
        }

        /// Compiles, verifies and runs the sample. The requested methods' IL
        /// and a description of every type token they use are read while
        /// the PE image is open, so nothing outlives its reader.
        private func CompileInspectAndRun(source string, methods ...string)(
            Output string,
            MethodIl IReadOnlyDictionary[string, []uint8],
            TypeTokens IReadOnlyDictionary[int32, string]
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
                let (methodIl, typeTokens) = InspectMethods(outputPath, methods)
                // Unsafe code is unverifiable by design; tolerate the inherent
                // unsafety codes and the verifier's missing `calli` support,
                // and still gate on every other verification error.
                try {
                    IlVerifier.Verify(outputPath, nil, UnsafeIlVerifyIgnored)
                } catch (ex XunitException) when OnlyUnsupportedCalli(ex.Message) {
                    // Known dotnet-ilverify limitation for `calli` only.

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
                // RunProcess drains both pipes concurrently and kills the
                // process tree on timeout, so a hanging sample fails the test.
                let (sampleExit, stdout, stderr) = IlVerifier.RunProcess(startInfo, outputPath, 30_000)
                Assert.True(sampleExit == 0, (`sample exited ` + "$sampleExit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (stdout.ReplaceLineEndings(Environment.NewLine), methodIl, typeTokens)
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch { }
            }
        }

        /// Reads each method's IL and describes every type token it uses,
        /// while the PE reader that backs the metadata is still open.
        private func InspectMethods(outputPath string, methods[]string)(
            MethodIl Dictionary[string, []uint8],
            TypeTokens Dictionary[int32, string]
        ) {
            let methodIl = Dictionary[string, []uint8](StringComparer.Ordinal)
            let typeTokens = Dictionary[int32, string]()
            using let stream = File.OpenRead(outputPath)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            for name in methods {
                let il = ReadMethodIl(peReader, metadata, name)
                methodIl[name] = il
                for instruction in IlInstructionReader.Read(il) {
                    if instruction
                        .OpCode
                        .OperandType == OperandType.InlineType ||
                        instruction
                        .OpCode
                        .OperandType == OperandType.InlineTok {
                        let token = TypeOperand(il, instruction)
                        typeTokens[token] = DescribeTypeToken(metadata, token)
                    }
                }
            }
            return (methodIl, typeTokens)
        }

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
