// <copyright file="Issue4943NarrowedFunctionPointerCallEmitTests.gs" company="GSharp">
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

/// Issue #4943: calling a smart-cast-narrowed nullable function pointer.
/// `(unmanaged[CC] () -> R)?` is stored as `Nullable<nint>`. The call path
/// built the narrowed callee read itself instead of going through
/// `ExpressionBinder.BuildNarrowedRead`, so the `Nullable<nint>` storage
/// reached `calli` without its unwrap and the call jumped to a garbage
/// address (SIGSEGV). Each test calls a real native export through every
/// narrowing form, so a crash fails it, and pins the unwrap before `calli`.
open class Issue4943NarrowedFunctionPointerCallEmitTests {
    @Fact
    func Narrowed_Local_And_Parameter_Calls_Unwrap_Before_Calli() {
        let source = Expand(`import System
import System.Runtime.InteropServices

unsafe func neqLocal(address nint) int32 {
    let fn = address as (unmanaged[CC] () -> int32)?
    if fn != nil {
        return fn()
    }
    return -1
}

unsafe func ifLet(address nint) int32 {
    if let fn = address as (unmanaged[CC] () -> int32)? {
        return fn()
    }
    return -1
}

unsafe func guardLet(address nint) int32 {
    guard let fn = address as (unmanaged[CC] () -> int32)? else {
        return -1
    }
    return fn()
}

unsafe func earlyReturn(address nint) int32 {
    let fn = address as (unmanaged[CC] () -> int32)?
    if fn == nil {
        return -1
    }
    return fn()
}

unsafe func param(fn (unmanaged[CC] () -> int32)?) int32 {
    if fn != nil {
        return fn()
    }
    return -1
}

unsafe func varLocal(address nint) int32 {
    var fn (unmanaged[CC] () -> int32)? = nil
    fn = address as (unmanaged[CC] () -> int32)?
    if fn != nil {
        return fn()
    }
    return -1
}

unsafe func run() {
    let address = NativeLibrary.GetExport(NativeLibrary.Load("LIBRARY"), "EXPORT")
    let pid = Environment.ProcessId
    Console.WriteLine(neqLocal(address) == pid)
    Console.WriteLine(ifLet(address) == pid)
    Console.WriteLine(guardLet(address) == pid)
    Console.WriteLine(earlyReturn(address) == pid)
    Console.WriteLine(param(address as (unmanaged[CC] () -> int32)?) == pid)
    Console.WriteLine(param(nil))
    Console.WriteLine(varLocal(address) == pid)
}

run()`)
        let methods = []string{"neqLocal", "ifLet", "guardLet", "earlyReturn", "param", "varLocal"}
        let result = CompileInspectAndRun(source, methods)
        Assert.Equal(
            string.Join(Environment.NewLine, "True", "True", "True", "True", "True", "-1", "True") +
                Environment.NewLine,
            result.Output
        )
        AssertEveryCalliUnwrapsItsPointer(result.MethodIl, result.MethodTokens, methods)
    }

    @Fact
    func Narrowed_Field_Calls_Unwrap_Before_Calli() {
        // The implicit (`Fp()`), `this.Fp()` and `h.Fp()` callees went through
        // the same call path; before the fix they reported GS0159 instead.
        let source = Expand(`import System
import System.Runtime.InteropServices

unsafe class Holder {
    let Fp (unmanaged[CC] () -> int32)?
    init(fp (unmanaged[CC] () -> int32)?) {
        Fp = fp
    }
    func CallImplicit() int32 {
        if Fp != nil {
            return Fp()
        }
        return -1
    }
    func CallThis() int32 {
        if this.Fp != nil {
            return this.Fp()
        }
        return -1
    }
}

unsafe func memberCall(h Holder) int32 {
    if h.Fp != nil {
        return h.Fp()
    }
    return -1
}

unsafe func run() {
    let address = NativeLibrary.GetExport(NativeLibrary.Load("LIBRARY"), "EXPORT")
    let pid = Environment.ProcessId
    let h = Holder(address as (unmanaged[CC] () -> int32)?)
    Console.WriteLine(h.CallImplicit() == pid)
    Console.WriteLine(h.CallThis() == pid)
    Console.WriteLine(memberCall(h) == pid)
    Console.WriteLine(memberCall(Holder(nil)))
}

run()`)
        let methods = []string{"CallImplicit", "CallThis", "memberCall"}
        let result = CompileInspectAndRun(source, methods)
        Assert.Equal(
            string.Join(Environment.NewLine, "True", "True", "True", "-1") + Environment.NewLine,
            result.Output
        )
        AssertEveryCalliUnwrapsItsPointer(result.MethodIl, result.MethodTokens, methods)
    }

    @Fact
    func Redundant_BangBang_On_A_Narrowed_Pointer_Is_Truly_Redundant() {
        // GS0536 calls `fn!!()` redundant after the nil check. It used to be
        // the only form that worked, so the advice led to the crash. Both
        // forms now emit the same unwrap and return the same result.
        let source = Expand(`import System
import System.Runtime.InteropServices

unsafe func withBangBang(address nint) int32 {
    let fn = address as (unmanaged[CC] () -> int32)?
    if fn == nil {
        return -1
    }
    return fn!!()
}

unsafe func withoutBangBang(address nint) int32 {
    let fn = address as (unmanaged[CC] () -> int32)?
    if fn == nil {
        return -1
    }
    return fn()
}

unsafe func run() {
    let address = NativeLibrary.GetExport(NativeLibrary.Load("LIBRARY"), "EXPORT")
    Console.WriteLine(withBangBang(address) == withoutBangBang(address))
    Console.WriteLine(withoutBangBang(address) == Environment.ProcessId)
}

run()`)
        let methods = []string{"withBangBang", "withoutBangBang"}
        let result = CompileInspectAndRun(source, methods)
        Assert.Contains("GS0536", result.CompilerOutput, StringComparison.Ordinal)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", result.Output)
        AssertEveryCalliUnwrapsItsPointer(result.MethodIl, result.MethodTokens, methods)
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

        /// Substitutes the platform's process-id export and its calling
        /// convention into the sample.
        private func Expand(template string) string {
            let (library, export, convention) = NativeProcessIdExport()
            return template.Replace("CC", convention).Replace("LIBRARY", library).Replace("EXPORT", export)
        }

        /// Every `calli` in the given methods must consume an unwrapped
        /// pointer: the instruction before it calls `Nullable<IntPtr>`'s
        /// `get_Value` / `GetValueOrDefault`, never a bare load of the
        /// `Nullable<nint>` storage.
        private func AssertEveryCalliUnwrapsItsPointer(
            methodIl IReadOnlyDictionary[string, []uint8],
            methodTokens IReadOnlyDictionary[int32, string],
            methods[]string
        ) {
            for method in methods {
                let il = IlInstructionReader.Read(methodIl[method])
                var calliCount = 0
                for var i = 0; i < il.Length; i++ {
                    if il[i].OpCode != OpCodes.Calli {
                        continue
                    }
                    calliCount++
                    Assert.True(i > 0, "$method: calli has no preceding instruction")
                    let previous = il[i - 1]
                    Assert.True(
                        previous.OpCode == OpCodes.Call,
                        "$method: calli is preceded by ${previous.OpCode}, not the Nullable<nint> unwrap call"
                    )
                    let callee = methodTokens[previous.MetadataToken ?? 0]
                    Assert.True(
                        callee == "Nullable`1.get_Value" || callee == "Nullable`1.GetValueOrDefault",
                        "$method: calli is preceded by a call to $callee, not the Nullable<nint> unwrap"
                    )
                }
                Assert.True(calliCount > 0, "$method has no calli")
            }
        }

        /// Names a method token `Type.Member` (a generic parent by its
        /// definition, e.g. ``Nullable`1.get_Value``).
        private func DescribeMethodToken(metadata MetadataReader, token int32) string {
            let handle = MetadataTokens.EntityHandle(token)
            if handle.Kind == HandleKind.MemberReference {
                let reference = metadata.GetMemberReference(MemberReferenceHandle(handle))
                return DescribeParent(metadata, reference.Parent) + "." + metadata.GetString(reference.Name)
            }
            if handle.Kind == HandleKind.MethodDefinition {
                return metadata.GetString(metadata.GetMethodDefinition(MethodDefinitionHandle(handle)).Name)
            }
            return handle.Kind.ToString()
        }

        private func DescribeParent(metadata MetadataReader, parent EntityHandle) string {
            if parent.Kind == HandleKind.TypeReference {
                return metadata.GetString(metadata.GetTypeReference(TypeReferenceHandle(parent)).Name)
            }
            if parent.Kind == HandleKind.TypeSpecification {
                let specification = metadata.GetTypeSpecification(TypeSpecificationHandle(parent))
                var blob = metadata.GetBlobReader(specification.Signature)
                if blob.ReadSignatureTypeCode() == SignatureTypeCode.GenericTypeInstance {
                    let _ = blob.ReadCompressedInteger()
                    return DescribeParent(metadata, blob.ReadTypeHandle())
                }
                return "TypeSpec"
            }
            return parent.Kind.ToString()
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
        private func CompileInspectAndRun(source string, methods[]string)(
            Output string,
            CompilerOutput string,
            MethodIl IReadOnlyDictionary[string, []uint8],
            TypeTokens IReadOnlyDictionary[int32, string],
            MethodTokens IReadOnlyDictionary[int32, string]
        ) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4943NarrowedFunctionPointerCallEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue4943.dll")
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
                let (methodIl, typeTokens, methodTokens) = InspectMethods(outputPath, methods)
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
                return (
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    standardOut.ToString() + standardError.ToString(),
                    methodIl,
                    typeTokens,
                    methodTokens
                )
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
            TypeTokens Dictionary[int32, string],
            MethodTokens Dictionary[int32, string]
        ) {
            let methodIl = Dictionary[string, []uint8](StringComparer.Ordinal)
            let typeTokens = Dictionary[int32, string]()
            let methodTokens = Dictionary[int32, string]()
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
                    } else if instruction.OpCode.OperandType == OperandType.InlineMethod {
                        let token = instruction.MetadataToken ?? 0
                        methodTokens[token] = DescribeMethodToken(metadata, token)
                    }
                }
            }
            return (methodIl, typeTokens, methodTokens)
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
