// <copyright file="Adr0095OpenCallingConventionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.IO
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit
import Xunit.Sdk

/// Emit coverage for ADR-0095 v2 / issue #3611 — the open CLR
/// calling-convention model. The blob facts are pinned against csc
/// (.NET 10): bare `unmanaged` encodes convention byte `0x09`
/// with no modopts; a convention list encodes `0x09` plus
/// `CallConv{Name}` optional modifiers on the return type in
/// <b>source order</b>; a single legacy name keeps its legacy
/// convention byte. Every emitted assembly must also pass ilverify.
open class Adr0095OpenCallingConventionEmitTests {
    @Fact
    func BareUnmanaged_EncodesUnmanagedConventionWithoutModopts() {
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc")
func bare(cb unmanaged () -> void) void;`
        let sig = EmitAndReadPInvokeSignature(source, "bare")
        let at = IndexOfFnPtr(sig)
        // FNPTR | Unmanaged | 0 params | ELEMENT_TYPE_VOID — csc-identical.
        Assert.Equal(Unmanaged, sig[at + 1])
        Assert.Equal(0x00, int32(sig[at + 2]))
        Assert.Equal(uint8(SignatureTypeCode.Void), sig[at + 3])
    }

    @Fact
    func SingleLegacyConvention_KeepsLegacyByteWithoutModopts() {
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc")
func legacy(cb unmanaged[Cdecl] (nint, nint) -> int32) void;`
        let sig = EmitAndReadPInvokeSignature(source, "legacy")
        let at = IndexOfFnPtr(sig)
        // FNPTR | CDecl (0x01) | 2 params | int32 return, no modopts.
        Assert.Equal(0x01, int32(sig[at + 1]))
        Assert.Equal(0x02, int32(sig[at + 2]))
        Assert.Equal(uint8(SignatureTypeCode.Int32), sig[at + 3])
    }

    @Fact
    func CombinedConventions_EmitReturnTypeModoptsInSourceOrder() {
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc")
func combined(cb unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32) void;`
        let (sig, modoptNames) = EmitAndReadPInvokeSignatureWithModopts(source, "combined")
        let at = IndexOfFnPtr(sig)
        Assert.Equal(Unmanaged, sig[at + 1])
        Assert.Equal(0x01, int32(sig[at + 2]))
        Assert.Equal(CModOpt, sig[at + 3])
        Assert.Equal([]string{"CallConvCdecl", "CallConvSuppressGCTransition"}, modoptNames)
    }

    @Fact
    func CombinedConventions_ReversedSourceOrder_ReversesModopts() {
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc")
func reversed(cb unmanaged[SuppressGCTransition, Cdecl] (int32) -> int32) void;`
        let (_, modoptNames) = EmitAndReadPInvokeSignatureWithModopts(source, "reversed")
        Assert.Equal([]string{"CallConvSuppressGCTransition", "CallConvCdecl"}, modoptNames)
    }

    @Fact
    func SingleNonLegacyConvention_EmitsUnmanagedPlusModopt() {
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc")
func suppress(cb unmanaged[SuppressGCTransition] (int32) -> int32) void;`
        let (sig, modoptNames) = EmitAndReadPInvokeSignatureWithModopts(source, "suppress")
        let at = IndexOfFnPtr(sig)
        Assert.Equal(Unmanaged, sig[at + 1])
        Assert.Equal([]string{"CallConvSuppressGCTransition"}, modoptNames)
    }

    shared {
        private const FnPtr uint8 = uint8(0x1B)
        private const Unmanaged uint8 = uint8(0x09)
        private const CModOpt uint8 = uint8(0x20)

        private func IndexOfFnPtr(signature[]uint8) int32 {
            let at = Array.IndexOf(signature, FnPtr)
            Assert.True(at >= 0, "expected an ELEMENT_TYPE_FNPTR byte in the P/Invoke signature")
            return at
        }

        private func EmitAndReadPInvokeSignature(source string, functionName string)[]uint8 -> EmitAndInspect(
            source,
            functionName,
            (sig[]uint8, _ IReadOnlyList[string]) -> sig
        )

        private func EmitAndReadPInvokeSignatureWithModopts(source string, functionName string)(
            Signature[]uint8,
            ModoptNames IReadOnlyList[string]
        ) -> EmitAndInspect(source, functionName, (sig[]uint8, names IReadOnlyList[string]) -> (sig, names))

        private func EmitAndInspect[T](
            source string,
            functionName string,
            project([]uint8, IReadOnlyList[string]) -> T
        ) T {
            let tempDir = Directory.CreateTempSubdirectory("gs_3611_cc_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath)
                IlVerifier.Verify(outPath)
                using let pe = PEReader(File.OpenRead(outPath))
                let md = pe.GetMetadataReader()
                for h in md.MethodDefinitions {
                    let m = md.GetMethodDefinition(h)
                    if md.GetString(m.Name) != functionName {
                        continue
                    }
                    let sig = md.GetBlobBytes(m.Signature)
                    return project(sig, ReadModoptNamesInBlobOrder(md, sig))
                }
                throw XunitException("expected an emitted P/Invoke method named $functionName")
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        /// Decodes the type names of the return-type `CMOD_OPT` run that
        /// follows the FNPTR header (`1B | conv | param-count`), in blob
        /// order. Blob order IS source order for the open calling-convention
        /// model (pinned against csc), so decoding the bytes directly — rather
        /// than through a signature provider whose modifier collection order is
        /// unspecified — is the point of the test.
        private func ReadModoptNamesInBlobOrder(md MetadataReader, signature[]uint8) IReadOnlyList[string] {
            let names = List[string]()
            var i = Array.IndexOf(signature, FnPtr)
            if i < 0 {
                return names
            }
            i += 3 // skip FNPTR, convention byte, and the (single-byte) param count
            while i < signature.Length && signature[i] == CModOpt {
                let coded = DecodeCompressedInteger(signature, i + 1, out var tokenLength)
                let handle = UncompressTypeDefOrRef(coded)
                if handle.Kind == HandleKind.TypeReference {
                    names.Add(md.GetString(md.GetTypeReference(TypeReferenceHandle(handle)).Name))
                }
                i += 1 + tokenLength
            }
            return names
        }

        private func DecodeCompressedInteger(blob[]uint8, offset int32, out length int32) int32 {
            let first = blob[offset]
            if (int32(first) & 0x80) == 0 {
                length = 1
                return first
            }
            if (int32(first) & 0xC0) == 0x80 {
                length = 2
                return ((int32(first) & 0x3F) << 8) | int32(blob[offset + 1])
            }
            length = 4
            return ((int32(first) & 0x1F) << 24) | (int32(blob[offset + 1]) << 16) | (
                int32(blob[offset + 2]) << 8
            ) | int32(blob[offset + 3])
        }

        private func UncompressTypeDefOrRef(coded int32) EntityHandle {
            let rowId = coded >> 2
            return switch (coded & 0x3) {
                case 0: MetadataTokens.EntityHandle(TableIndex.TypeDef, rowId)
                case 1: MetadataTokens.EntityHandle(TableIndex.TypeRef, rowId)
                default: MetadataTokens.EntityHandle(TableIndex.TypeSpec, rowId)
            }
        }

        private func CompileOrThrow(srcPath string, outPath string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
