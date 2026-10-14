// <copyright file="Issue2838GenericPointerStrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2838: pointer arithmetic over a pointer to an `unmanaged`-constrained
/// generic type parameter silently used a hard-coded 8-byte stride.
///
/// An open `TypeParameterSymbol` has no
/// reference-context CLR type (its `ClrType` is `null`), so the
/// pointee-size classifier did not see a value type and fell back to the
/// `nint.Size` literal. Every instantiation — `*uint8`, `*uint16`,
/// `*int32` — therefore scaled by 8. That is a WRONG-ANSWER bug, not merely a
/// verification failure, so these tests execute the emitted code and assert the
/// computed strides rather than only inspecting metadata.
///
/// A secondary defect in the same report: `fixed p *T = span` emitted the
/// `GetPinnableReference()` MemberRef parented at the erased
/// `Span`1<object>` while the receiver on the stack was
/// `Span`1<!!T>`. The parent must be a TypeSpec naming the type
/// parameter.
open class Issue2838GenericPointerStrideEmitTests {
    /// The headline regression: `(p + 1) - p` over `*T` must advance by
    /// `sizeof(T)`. Before the fix every instantiation printed `8`.
    @Fact
    func PointerDifference_OverGenericUnmanaged_UsesRuntimeStride() {
        let source = `package Probe

import System

class Stride {
    shared {
        func PointerStride[T unmanaged](xs Span[T]) int64 {
            unsafe {
                var d int64 = 0
                fixed p *T = xs {
                    d = int64((p + 1)) - int64(p)
                }
                return d
            }
        }
    }
}

func run() {
    Console.WriteLine(Stride.PointerStride[uint8]([8]uint8))
    Console.WriteLine(Stride.PointerStride[uint16]([8]uint16))
    Console.WriteLine(Stride.PointerStride[int32]([8]int32))
    Console.WriteLine(Stride.PointerStride[int64]([8]int64))
}

run()`
        let output = CompileAndRun(source, UnsafeIlVerifyIgnored)
        Assert.Equal(
            "1${Environment.NewLine}2${Environment.NewLine}4${Environment.NewLine}8${Environment.NewLine}",
            output
        )
    }

    /// Covers the other consumer of the pointee-size helper: scaling a
    /// non-constant offset (`p + n`) rather than a literal `+ 1`.
    @Fact
    func PointerOffset_OverGenericUnmanaged_ScalesByElementSize() {
        let source = `package Probe

import System

class Stride {
    shared {
        func OffsetDelta[T unmanaged](xs Span[T], n int32) int64 {
            unsafe {
                var d int64 = 0
                fixed p *T = xs {
                    d = int64((p + n)) - int64(p)
                }
                return d
            }
        }
    }
}

func run() {
    Console.WriteLine(Stride.OffsetDelta[uint8]([8]uint8, 3))
    Console.WriteLine(Stride.OffsetDelta[uint16]([8]uint16, 3))
    Console.WriteLine(Stride.OffsetDelta[int32]([8]int32, 3))
    Console.WriteLine(Stride.OffsetDelta[int64]([8]int64, 3))
}

run()`
        let output = CompileAndRun(source, UnsafeIlVerifyIgnored)
        Assert.Equal(
            "3${Environment.NewLine}6${Environment.NewLine}12${Environment.NewLine}24${Environment.NewLine}",
            output
        )
    }

    /// Metadata-level guard for both defects, so a future regression is diagnosed
    /// at the IL shape rather than only as a wrong printed number:
    /// the stride must be the `sizeof` opcode (never a baked-in
    /// `ldc.i4.8`), and the `GetPinnableReference` MemberRef must be
    /// parented at a TypeSpec that names the method type parameter.
    @Fact
    func GenericPointerWalk_EmitsSizeOfOpcodeAndSymbolicPinnableParent() {
        let source = `package Probe

import System

class Stride {
    shared {
        func PointerStride[T unmanaged](xs Span[T]) int64 {
            unsafe {
                var d int64 = 0
                fixed p *T = xs {
                    d = int64((p + 1)) - int64(p)
                }
                return d
            }
        }
    }
}

func run() {
    Console.WriteLine(Stride.PointerStride[int32]([8]int32))
}

run()`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue2838_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let il = GetMethodIl(pe, md, "PointerStride")
            // ECMA-335 III.1.2.1: `sizeof` is the two-byte prefixed opcode
            // 0xFE 0x1C. Its presence proves the stride is computed from the
            // runtime type token rather than a compile-time constant.
            Assert.True(
                ContainsSequence(il, uint8(0xFE), uint8(0x1C)),
                "PointerStride must scale by the `sizeof` opcode over the generic type token."
            )
            // `ldc.i4.8; conv.i` (0x1E 0xD3) was the exact erased-stride
            // emission. Matching the pair rather than the bare constant avoids
            // false positives from 0x1E appearing inside a metadata token.
            Assert.False(
                ContainsSequence(il, uint8(0x1E), uint8(0xD3)),
                "PointerStride must not bake in an 8-byte stride."
            )
            AssertPinnableReferenceParentNamesTypeParameter(md)
        } finally {
            TryDeleteDir(tempDir)
        }
    }

    /// Issue #2838 symptom 2: passing a `*T` to an imported generic method
    /// (`Vector256.Load[T](*T)`) must infer `T`, not the erased
    /// `object`. Before the fix the open pointer parameter matched none of
    /// the unifier's structural forms, so the MethodSpec closed over
    /// `System.Object` — emitting `Vector256::Load<System.Object>`,
    /// which is not a constructible instantiation and failed verification with
    /// `StackUnexpected`. This mirrors the real
    /// `Oahu.Decrypt.Mpeg4.Util.HelperExtensions` shape.
    @Fact
    func GenericPointerArgument_ToImportedGenericMethod_InfersTypeParameter() {
        let source = `package Probe

import System
import System.Runtime.Intrinsics

class V {
    shared {
        func AllLessOrEqual[T unmanaged](ints Span[T], comparand Vector256[T]) bool {
            unsafe {
                var ok = true
                fixed p *T = ints {
                    let v = Vector256.Load(p)
                    ok = Vector256.LessThanOrEqualAll(v, comparand)
                }
                return ok
            }
        }
    }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue2838_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, "library")
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            let specCount = md.GetTableRowCount(TableIndex.MethodSpec)
            Assert.True(specCount > 0, "expected at least one MethodSpec for the generic Vector256 calls")
            var sawLoad = false
            for var i = 1; i <= specCount; i++ {
                let spec = md.GetMethodSpecification(MetadataTokens.MethodSpecificationHandle(i))
                if spec.Method.Kind != HandleKind.MemberReference {
                    continue
                }
                let name = md.GetString(md.GetMemberReference(MemberReferenceHandle(spec.Method)).Name)
                let blob = md.GetBlobBytes(spec.Signature)
                // ECMA-335 II.23.2.15: GENERICINST (0x0A), argument count, then
                // each argument. `1E 00` is MVAR(0) — the method type parameter.
                // `1C` is ELEMENT_TYPE_OBJECT, the erasure this test guards.
                Assert.False(
                    Array.IndexOf(blob, uint8(0x1C)) >= 0,
                    "MethodSpec for '$name' closed over the erased System.Object: ${BitConverter.ToString(blob)}"
                )
                if name == "Load" {
                    sawLoad = true
                    Assert.True(
                        ContainsSequence(blob, uint8(0x1E), uint8(0x00)),
                        "Vector256.Load must close over the method type parameter, was ${BitConverter.ToString(blob)}"
                    )
                }
            }
            Assert.True(sawLoad, "no MethodSpec found for Vector256.Load")
        } finally {
            TryDeleteDir(tempDir)
        }
    }

    shared {
        // Raw-pointer code is unverifiable by design. This is the established
        // tolerated set for the `fixed` pinnable-reference form (see
        // Issue1043FixedPinnableEmitTests): `conv.u` on the pinned `T&` is exactly
        // what C# emits and is inherently unverifiable. Listing only these codes
        // keeps unrelated verification regressions failing the test.
        private let UnsafeIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        private func AssertPinnableReferenceParentNamesTypeParameter(md MetadataReader) {
            var found = false
            for mrh in md.MemberReferences {
                let mr = md.GetMemberReference(mrh)
                if md.GetString(mr.Name) != "GetPinnableReference" {
                    continue
                }
                found = true
                // The receiver is `Span[T]`, so the parent must be a TypeSpec — a
                // plain TypeRef parent would be the erased `Span<object>`.
                Assert.True(
                    mr.Parent.Kind == HandleKind.TypeSpecification,
                    "GetPinnableReference parent must be a TypeSpecification, was ${mr.Parent.Kind}."
                )
                let spec = md.GetTypeSpecification(TypeSpecificationHandle(mr.Parent))
                let blob = md.GetBlobBytes(spec.Signature)
                // ECMA-335 II.23.1.16: ELEMENT_TYPE_MVAR (0x1E) — the method-level
                // generic parameter `!!T`. Its absence means the argument erased.
                Assert.Contains(uint8(0x1E), blob)
            }
            Assert.True(found, "no GetPinnableReference MemberRef found in emitted metadata")
        }

        private func GetMethodIl(pe PEReader, md MetadataReader, methodName string)[]uint8 {
            for mh in md.MethodDefinitions {
                let mdef = md.GetMethodDefinition(mh)
                if md.GetString(mdef.Name) != methodName || mdef.RelativeVirtualAddress == 0 {
                    continue
                }
                return pe.GetMethodBody(mdef.RelativeVirtualAddress).GetILBytes() ??
                    throw InvalidOperationException("method '$methodName' has no IL body")
            }
            throw InvalidOperationException("method '$methodName' not found in emitted metadata")
        }

        private func ContainsSequence(haystack[]uint8, needle ...uint8) bool {
            for var i = 0; i + needle.Length <= haystack.Length; i++ {
                var match = true
                for var j = 0; j < needle.Length; j++ {
                    if (haystack[i + j] != needle[j]) {
                        match = false
                        break
                    }
                }
                if match {
                    return true
                }
            }
            return false
        }

        private func CompileOrThrow(srcPath string, outPath string, target string = "exe") {
            let args = []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
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

        private func CompileAndRun(source string, ignoredIlVerifyCodes[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2838_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath)
                IlVerifier.Verify(outPath, nil, ignoredIlVerifyCodes)
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                TryDeleteDir(tempDir)
            }
        }

        private func TryDeleteDir(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch {
                // ignored

            }
        }
    }
}
