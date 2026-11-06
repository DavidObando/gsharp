// <copyright file="Issue5818PointerDataStructEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #5818: `data struct`, `data class`, and `inline struct` members over
/// raw pointers (`*T`, `*void`, `**T`) and function pointers must compare with
/// `ceq`, hash as `nint` (`System.IntPtr`), deconstruct with `stind.i`, and skip
/// pointer and function-pointer members in `PrintMembers` so `ILVerify` and
/// NativeAOT `ilc` accept every synthesized method.
open class Issue5818PointerDataStructEmitTests {
    @Fact
    func RawPointerAndFunctionPointerDataTypes_VerifyAndExecuteSynthesizedMembers() {
        const source = `package Goo
import System
import System.Runtime.InteropServices

internal unsafe data struct VulkanWindowTargetExtensionPointer {
    var Value *int8
}

unsafe data struct MultiPointerStruct(Head *int8, Raw *void, DoublePtr **int32, Callback unmanaged[Cdecl] (int32) -> int32, Managed *func(int32) int32, Label string)

unsafe data class PointerRecordClass(Ptr *int8, Fn unmanaged[Cdecl] (int32) -> int32, Tag int32) {
    var Extra *void
}

unsafe data struct TenPointerFoldStruct {
    var P1 *int8
    var P2 *void
    var P3 **int32
    var P4 unmanaged[Cdecl] (int32) -> int32
    var P5 *func(int32) int32
    var P6 *int8
    var P7 *void
    var P8 *int32
    var P9 *int8
    var P10 int32
}

unsafe inline struct InlinePointerWrapper(Value *int8)

func ManagedDec(x int32) int32 -> x - 1

unsafe func Run() string {
    let pa = *int8(nint(100))
    let pb = *int8(nint(200))
    let pc = *int32(nint(300))
    let ppc = cast[**int32](nint(400))
    let first = VulkanWindowTargetExtensionPointer{Value: pa}
    let same = VulkanWindowTargetExtensionPointer{Value: pa}
    let diff = VulkanWindowTargetExtensionPointer{Value: pb}
    let eqSame = first.Equals(same) && first.Equals(box(same)) && (first == same) && !(first != same)
    let eqDiff = !first.Equals(diff) && !first.Equals(box(diff)) && !(first == diff) && (first != diff)
    let hashMatches = first.GetHashCode() == same.GetHashCode()
    let (firstVal) = first
    let deconstructedOk = firstVal == pa

    let fp = cast[unmanaged[Cdecl] (int32) -> int32](nint(4096))
    let mp *func(int32) int32 = &ManagedDec
    let s1 = MultiPointerStruct(pa, *void(pb), ppc, fp, mp, "ok")
    let s2 = MultiPointerStruct(pa, *void(pb), ppc, fp, mp, "ok")
    let s3 = MultiPointerStruct(pb, *void(pb), ppc, fp, mp, "ok")
    let (dHead, dRaw, dDouble, dCb, dManaged, dLabel) = s1
    let multiOk = s1 == s2 && s1 != s3 && s1.GetHashCode() == s2.GetHashCode() && dHead == pa && dRaw == *void(pb) && dDouble == ppc && dCb == fp && dManaged == mp && dLabel == "ok"

    let c1 = PointerRecordClass{Ptr: pa, Fn: fp, Tag: 7, Extra: *void(pb)}
    let c2 = PointerRecordClass{Ptr: pa, Fn: fp, Tag: 7, Extra: *void(pb)}
    let c3 = c1.copy(Ptr: pb)
    let (cPtr, cFn, cTag) = c1
    let classOk = c1 == c2 && c1 != c3 && c1.Equals(box(c2)) && c1.GetHashCode() == c2.GetHashCode() && cPtr == pa && cFn == fp && cTag == 7

    let f1 = TenPointerFoldStruct{P1: pa, P2: *void(pb), P3: ppc, P4: fp, P5: mp, P6: pa, P7: *void(pa), P8: pc, P9: pb, P10: 42}
    let f2 = TenPointerFoldStruct{P1: pa, P2: *void(pb), P3: ppc, P4: fp, P5: mp, P6: pa, P7: *void(pa), P8: pc, P9: pb, P10: 42}
    let (fP1, fP2, fP3, fP4, fP5, fP6, fP7, fP8, fP9, fP10) = f1
    let foldOk = f1 == f2 && f1.GetHashCode() == f2.GetHashCode() && fP1 == pa && fP2 == *void(pb) && fP3 == ppc && fP4 == fp && fP5 == mp && fP6 == pa && fP7 == *void(pa) && fP8 == pc && fP9 == pb && fP10 == 42

    let iw1 = InlinePointerWrapper(pa)
    let iw2 = InlinePointerWrapper(pa)
    let iw3 = InlinePointerWrapper(pb)
    let (iwVal) = iw1
    let inlineOk = iw1 == iw2 && iw1 != iw3 && iw1.Equals(box(iw2)) && iw1.GetHashCode() == iw2.GetHashCode() && iwVal == pa && iw1.ToString()?.StartsWith("InlinePointerWrapper(Value=", StringComparison.Ordinal) == true

    return "${eqSame}|${eqDiff}|${hashMatches}|${deconstructedOk}|${first}|${multiOk}|${s1}|${classOk}|${c1}|${foldOk}|${f1}|${inlineOk}"
}

func box[T](value T) object -> value
`
        let tempDir = Directory.CreateTempSubdirectory("gs_5818_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, "${compileOut}${compileErr}")
            IlVerifier.Verify(outPath, nil, []string{"UnmanagedPointer"})
            let assembly = EmittedFixture.Load(outPath)
            Assert.Equal(
                "True|True|True|True|VulkanWindowTargetExtensionPointer { }|True|MultiPointerStruct { Label = ok }|True|PointerRecordClass { Tag = 7 }|True|TenPointerFoldStruct { P10 = 42 }|True",
                Adr0199RecordAbiWitness.Invoke(assembly, "Run")
            )
            for typeName in[]string{
                "VulkanWindowTargetExtensionPointer",
                "MultiPointerStruct",
                "PointerRecordClass",
                "TenPointerFoldStruct",
                "InlinePointerWrapper"
            } {
                let targetType = assembly.GetTypes().Single((t Type) -> t.Name == typeName)
                Assert.NotNull(targetType.GetMethod("Deconstruct"))
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func DownlevelWithoutSystemHashCode_UsesIntPtrEqualityComparerForPointerFields() {
        let netstandard = Issue4921HostFallbackEmbeddableAttributeTests.FindNetStandardReference()
        Assert.NotNull(netstandard)
        const source = `package DownlevelPtr
unsafe data struct PtrPair(First *int8, Second unmanaged[Cdecl] () -> void, Count int32)
`
        let tempDir = Directory.CreateTempSubdirectory("gs_5818_downlevel_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = Program.Main(
                    []string{
                        "/out:" + outPath,
                        "/target:library",
                        "/targetframework:netstandard2.0",
                        "/reference:" + netstandard!!,
                        srcPath
                    }
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, "${compileOut}${compileErr}")
            IlVerifier.Verify(outPath, []string{netstandard!!}, []string{"UnmanagedPointer"})
            using let stream = File.OpenRead(outPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let assemblyRefs = reader
                .AssemblyReferences
                .Select((h AssemblyReferenceHandle) -> reader.GetString(reader.GetAssemblyReference(h).Name))
                .ToArray()
            Assert.Equal([]string{"netstandard"}, assemblyRefs)
            var hasEqualityComparerTypeRef = false
            for handle in reader.TypeReferences {
                let tr = reader.GetTypeReference(handle)
                let name = reader.GetString(tr.Name)
                Assert.NotEqual("HashCode", name)
                if reader.GetString(tr.Namespace) == "System.Collections.Generic" && name == "EqualityComparer`1" {
                    hasEqualityComparerTypeRef = true
                }
            }
            Assert.True(hasEqualityComparerTypeRef, "expected EqualityComparer`1 TypeRef")
            let typeSpecCount = reader.GetTableRowCount(TableIndex.TypeSpec)
            var hasIntPtrGenericInst = false
            for var row = 1; row <= typeSpecCount; row++ {
                let specHandle = MetadataTokens.TypeSpecificationHandle(row)
                let bytes = reader.GetBlobBytes(reader.GetTypeSpecification(specHandle).Signature)
                // Generic instantiations (0x15) must never contain ELEMENT_TYPE_PTR (0x0F) or ELEMENT_TYPE_FNPTR (0x1B).
                if bytes.Length > 0 && bytes[0] == 0x15 {
                    Assert.DoesNotContain(uint8(0x0F), bytes)
                    Assert.DoesNotContain(uint8(0x1B), bytes)
                    if bytes[bytes.Length - 1] == 0x18 {
                        hasIntPtrGenericInst = true
                    }
                }
            }
            Assert.True(
                hasIntPtrGenericInst,
                "expected EqualityComparer<nint> TypeSpec ending in ELEMENT_TYPE_I (0x18)"
            )
            let loaded = EmittedFixture.Load(outPath)
            let ptrPairType = loaded.GetTypes().Single((t Type) -> t.Name == "PtrPair")
            let p1 = Activator.CreateInstance(ptrPairType)!!
            let p2 = Activator.CreateInstance(ptrPairType)!!
            Assert.Equal(p1.GetHashCode(), p2.GetHashCode())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }
}
