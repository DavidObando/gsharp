// <copyright file="Issue1504LibraryImportStringReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Buffers.Binary
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// Emit + execute + ilverify coverage for issue #1504 (ADR-0092 §2): an
/// `@LibraryImport` function whose return type is `string`. The
/// inner blittable P/Invoke returns the raw native pointer (encoded as
/// `IntPtr`); the outer managed stub materializes a managed
/// `string` via (cref:Marshal.PtrToStringUTF8(IntPtr)) /
/// (cref:Marshal.PtrToStringUni(IntPtr)) per the resolved
/// (cref:StringMarshalling). The returned native buffer is
/// non-owning (the native side owns it, e.g. `getenv`), so the stub
/// never frees it — only marshalled string <em>parameters</em> are freed in
/// the `finally`.
open class Issue1504LibraryImportStringReturnEmitTests {
    @Fact
    func StringReturn_Utf8_GetenvRoundTrip_ReturnsManagedString() {
        if !IsLibcCallable() {
            return // skip-not-fail on platforms without libc

        }
        // setenv + getenv are POSIX and share the process environ, so the
        // round-trip is deterministic and memory-safe: getenv returns a
        // pointer owned by libc that the stub never frees.
        const source = `package P1504U8RoundTrip
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "setenv", StringMarshalling: StringMarshalling.Utf8)
func set_env_u8(name string, value string, overwrite int32) int32;

@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
func get_env_u8(name string) string;

var rc = set_env_u8("GS_ISSUE_1504_U8", "round-trip-value", 1)
Console.WriteLine(get_env_u8("GS_ISSUE_1504_U8"))`
        let output = CompileAndRun(source)
        Assert.Equal("round-trip-value${Environment.NewLine}", output)
    }

    @Fact
    func StringReturn_Utf8_MissingEnv_ReturnsNilString() {
        if !IsLibcCallable() {
            return
        }
        // getenv on an unset name returns IntPtr.Zero; PtrToStringUTF8 maps
        // that to null, so the managed value compares equal to `nil`.
        const source = `package P1504U8Missing
import System
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
func get_env_missing_u8(name string) string;

var v = get_env_missing_u8("GS_ISSUE_1504_DOES_NOT_EXIST")
Console.WriteLine(v == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func StringReturn_Utf8_WithParam_OuterReturnsString_InnerReturnsIntPtr_MaterializesAndDoesNotFreeReturn() {
        const source = `package P1504U8Shape
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
func GetEnvShapeU8(name string) string;`
        AssertStubShape(
            source,
            outerName: "GetEnvShapeU8",
            expectedConvert: "StringToCoTaskMemUTF8",
            expectedMaterialize: "PtrToStringUTF8",
            expectedConvertCount: 1,
            expectedFreeCount: 1,
            expectedMaterializeCount: 1
        )
    }

    @Fact
    func StringReturn_Utf16_WithParam_OuterReturnsString_InnerReturnsIntPtr_UsesPtrToStringUni() {
        const source = `package P1504U16Shape
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "wide_lookup", StringMarshalling: StringMarshalling.Utf16)
func WideLookupU16(key string) string;`
        AssertStubShape(
            source,
            outerName: "WideLookupU16",
            expectedConvert: "StringToCoTaskMemUni",
            expectedMaterialize: "PtrToStringUni",
            expectedConvertCount: 1,
            expectedFreeCount: 1,
            expectedMaterializeCount: 1
        )
    }

    @Fact
    func StringReturn_Utf8_ReturnOnly_NoParams_DoesNotFreeReturn() {
        // No string parameters → the stub never allocates or frees a
        // CoTaskMem buffer, and crucially never frees the return pointer.
        const source = `package P1504U8ReturnOnly
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getprogname", StringMarshalling: StringMarshalling.Utf8)
func GetProgNameU8() string;`
        AssertStubShape(
            source,
            outerName: "GetProgNameU8",
            expectedConvert: "StringToCoTaskMemUTF8",
            expectedMaterialize: "PtrToStringUTF8",
            expectedConvertCount: 0,
            expectedFreeCount: 0,
            expectedMaterializeCount: 1
        )
    }

    @Fact
    func StringReturn_Utf16_ReturnOnly_NoParams_DoesNotFreeReturn() {
        const source = `package P1504U16ReturnOnly
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "wide_progname", StringMarshalling: StringMarshalling.Utf16)
func WideProgNameU16() string;`
        AssertStubShape(
            source,
            outerName: "WideProgNameU16",
            expectedConvert: "StringToCoTaskMemUni",
            expectedMaterialize: "PtrToStringUni",
            expectedConvertCount: 0,
            expectedFreeCount: 0,
            expectedMaterializeCount: 1
        )
    }

    /// Minimal (cref:ISignatureTypeProvider{TType, TGenericContext}) that
    /// renders each referenced type by name so the test can assert the outer
    /// stub returns `String` while the inner P/Invoke returns
    /// `IntPtr`.
    private class NameSignatureProvider : ISignatureTypeProvider[string, object] {
        private let reader MetadataReader

        init(reader MetadataReader) {
            this.reader = reader
        }

        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[]"

        func GetByReferenceType(elementType string) string -> "ref " + elementType

        func GetFunctionPointerType(signature MethodSignature[string]) string -> "fnptr"

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "<...>"

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType

        func GetPinnedType(elementType string) string -> elementType

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetTypeFromDefinition(
            metadataReader MetadataReader,
            handle TypeDefinitionHandle,
            rawTypeKind uint8
        ) string {
            let def = metadataReader.GetTypeDefinition(handle)
            let ns = metadataReader.GetString(def.Namespace)
            let name = metadataReader.GetString(def.Name)
            return if string.IsNullOrEmpty(ns) {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromReference(metadataReader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string {
            let typeRef = metadataReader.GetTypeReference(handle)
            let ns = metadataReader.GetString(typeRef.Namespace)
            let name = metadataReader.GetString(typeRef.Name)
            return if string.IsNullOrEmpty(ns) {
                name
            } else {
                ns + "." + name
            }
        }

        func GetTypeFromSpecification(
            metadataReader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> "spec"
    }

    shared {
        private func AssertStubShape(
            source string,
            outerName string,
            expectedConvert string,
            expectedMaterialize string,
            expectedConvertCount int32,
            expectedFreeCount int32,
            expectedMaterializeCount int32
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1504_shape_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath, target: "library")
                IlVerifier.Verify(outPath)
                using let pe = PEReader(File.OpenRead(outPath))
                let md = pe.GetMetadataReader()
                let provider = Issue1504LibraryImportStringReturnEmitTests.NameSignatureProvider(md)
                var outerIl[]?uint8 = nil
                var foundOuter = false
                var foundInner = false
                for h in md.MethodDefinitions {
                    let m = md.GetMethodDefinition(h)
                    let name = md.GetString(m.Name)
                    if name == outerName {
                        foundOuter = true
                        // Outer stub is managed (NOT PinvokeImpl) and its
                        // user-visible signature returns a managed string.
                        Assert.True((m.Attributes & MethodAttributes.PinvokeImpl) == 0)
                        let sig = m.DecodeSignature(provider, genericContext: nil)
                        Assert.Equal("String", sig.ReturnType)
                        Assert.NotEqual(-1, m.RelativeVirtualAddress)
                        outerIl = pe.GetMethodBody(m.RelativeVirtualAddress).GetILBytes()
                    } else if name.Contains(outerName) && name.Contains("PInvoke") {
                        foundInner = true
                        // Inner blittable P/Invoke returns the raw native pointer.
                        Assert.True((m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl)
                        let sig = m.DecodeSignature(provider, genericContext: nil)
                        Assert.Equal("IntPtr", sig.ReturnType)
                    }
                }
                Assert.True(foundOuter, "expected an emitted outer stub named $outerName")
                Assert.True(foundInner, "expected an emitted inner P/Invoke for $outerName")
                Assert.NotNull(outerIl)
                let marshalCalls = CollectMarshalCalls(outerIl, md)
                Assert.Equal(expectedMaterializeCount, CountCall(marshalCalls, expectedMaterialize))
                Assert.Equal(expectedConvertCount, CountCall(marshalCalls, expectedConvert))
                Assert.Equal(expectedFreeCount, CountCall(marshalCalls, "FreeCoTaskMem"))
                // The non-owning return policy: the materialize helper is called,
                // but the return pointer is never routed through FreeCoTaskMem.
                // FreeCoTaskMem appears exactly once per marshalled *parameter*.

            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CountCall(calls IReadOnlyDictionary[string, int32], name string) int32 -> if calls.TryGetValue(
            name,
            out var n
        ) {
            n
        } else {
            0
        }

        /// Walks the outer stub's IL, resolving every `call` (0x28) token to
        /// a (cref:MemberReference) whose parent type is
        /// (cref:Marshal), and returns the multiset of member names called.
        /// Tokens that do not resolve to a Marshal MemberRef (e.g. the inner
        /// P/Invoke MethodDef call, or a 0x28 byte that is part of an operand) are
        /// ignored.
        private func CollectMarshalCalls(il[]?uint8, md MetadataReader) Dictionary[string, int32] {
            let result = Dictionary[string, int32](StringComparer.Ordinal)
            for var i = 0; i + 4 < il!!.Length; i++ {
                if il!![i] != uint8(0x28) {
                    continue // ECMA-335 `call`

                }
                let token = BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(i + 1, 4))
                var handle EntityHandle
                try {
                    handle = MetadataTokens.EntityHandle(token)
                } catch (ArgumentException) {
                    continue
                }
                if handle.Kind != HandleKind.MemberReference {
                    continue
                }
                var mr MemberReference
                try {
                    mr = md.GetMemberReference(MemberReferenceHandle(handle))
                } catch {
                    continue
                }
                if mr.Parent.Kind != HandleKind.TypeReference {
                    continue
                }
                let parent = md.GetTypeReference(TypeReferenceHandle(mr.Parent))
                if md.GetString(parent.Name) != "Marshal" {
                    continue
                }
                let memberName = md.GetString(mr.Name)
                result[memberName] = (
                    if result.TryGetValue(memberName, out var c) {
                        c
                    } else {
                        0
                    }
                ) +
                    1
            }
            return result
        }

        private func IsLibcCallable() bool -> RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX)

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1504_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath, target: "exe")
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileOrThrow(srcPath string, outPath string, target string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }
    }
}
