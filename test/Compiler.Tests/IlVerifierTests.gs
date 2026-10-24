// <copyright file="IlVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Gsharp.Values
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit
import Xunit.Sdk

/// Smoke tests for the (cref:IlVerifier) helper itself. These guard the
/// gate: if these break, every Compile…+Verify call elsewhere in this assembly
/// is producing meaningless results.
open class IlVerifierTests {
    @Fact
    func LiteralRefLikeReturn_AdmitsOnlyFrozenIndependentlyWitnessedImage() {
        let directory = Directory.CreateTempSubdirectory("ilverify-literal-proof-").FullName
        try {
            let dll = WriteLiteralProof(directory, byRef: false)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("1 Error(s) Verifying " + dll, report, StringComparison.Ordinal)
            Assert.Contains("Utf8Proof.Utf8Candidate::Get()][offset 0x00000014]", report, StringComparison.Ordinal)
            Assert.True(IlVerifyFalsePositives.OnlyKnown(dll, report), report)
            Assert.Equal(0, RunStandaloneAdapter(dll, report, expectApprovedReturn: true, expectedAccepted: 1))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    func LiteralRefLikeReturn_RejectsActualByRefAndSameDiagnosticStorageMutants(mutant int32) {
        let directory = Directory.CreateTempSubdirectory("ilverify-literal-negative-").FullName
        try {
            let dll = WriteLiteralProof(directory, byRef: mutant == 0)
            let bytes = File.ReadAllBytes(dll)
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let method = md.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(1))
            if mutant == 0 {
                Assert.Equal(uint8(0x10), md.GetBlobBytes(method.Signature)[2])
            } else if mutant == 1 {
                let field = md.GetFieldDefinition(MetadataTokens.FieldDefinitionHandle(1))
                let rva = field.GetRelativeVirtualAddress()
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single((s SectionHeader) -> rva >= s.VirtualAddress && rva < s.VirtualAddress + s.SizeOfRawData)
                bytes[rva - section.VirtualAddress + section.PointerToRawData + 4] = uint8(0x7F)
            } else if mutant == 2 {
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                        method.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let code = header + int32(bytes[header + 1] >> 4) * 4
                Assert.Equal(uint8(0x1A), bytes[code + 14])
                bytes[code + 14] = uint8(0x1B)
            } else {
                let name = pe.PEHeaders.MetadataStartOffset + md.GetHeapMetadataOffset(HeapIndex.String) +
                    MetadataTokens.GetHeapOffset(method.Name)
                bytes[name + 1] = uint8('u')
            }
            File.WriteAllBytes(dll, bytes)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[ReturnPtrToStack]", report, StringComparison.Ordinal)
            Assert.Contains("1 Error(s) Verifying " + dll, report, StringComparison.Ordinal)
            if mutant == 0 {
                // A forged permitted offset must not turn the actual byref signature into a safe by-value image.
                Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("0x00000017", "0x00000014")))
            }
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report), report)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    private func WriteLiteralProof(directory string, byRef bool) string {
        let name = if byRef {
            "TrueByRefNegative"
        } else {
            "Utf8Candidate"
        }
        let source = Path.Combine(
            IlVerifier.FindRepoRoot(),
            "test",
            "Compiler.Tests",
            "TestData",
            "IlVerify",
            name + ".base64.txt"
        )
        let dll = Path.Combine(directory, name + ".dll")
        File.WriteAllBytes(dll, Convert.FromBase64String(File.ReadAllText(source)))
        return dll
    }

    @Fact
    func RuntimeRefLikeReturns_RequireApprovedExactProductionProof() {
        let dll = typeof(Slice[_]).Assembly.Location
        let report = StaticInterfaceReport(dll)
        Assert.Contains("2 Error(s) Verifying " + dll, report, StringComparison.Ordinal)
        Assert.Contains("Slice`1::AsSpan()][offset 0x00000017]", report, StringComparison.Ordinal)
        Assert.Contains("ReadOnlySlice`1::AsSpan()][offset 0x00000010]", report, StringComparison.Ordinal)
        Assert.True(
            IlVerifyFalsePositives.OnlyKnown(dll, report),
            report + "\nAudited runtime proof: " + IlVerifyFalsePositives.RuntimeReturnProof(dll)
        )
        let accepted = IlVerifyFalsePositives.Analyze(dll, report)
        Assert.True(accepted.Complete)
        Assert.Equal(2, accepted.Accepted.Length)
        Assert.Empty(accepted.Unexpected)
        Assert.All(
            accepted.Accepted,
            (line string) -> Assert.Contains("[approved #5244; dotnet/runtime#129030]", line, StringComparison.Ordinal)
        )
        Assert.Equal(0, RunStandaloneAdapter(dll, report, expectApprovedReturn: true))
    }

    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    @InlineData(int32(4))
    @InlineData(int32(5))
    @InlineData(int32(6))
    @InlineData(int32(7))
    @InlineData(int32(8))
    @InlineData(int32(9))
    @InlineData(int32(10))
    @InlineData(int32(11))
    @InlineData(int32(12))
    @InlineData(int32(13))
    func RuntimeRefLikeReturns_RejectMalformedAndNearMissReports(mutant int32) {
        let dll = typeof(Slice[_]).Assembly.Location
        let report = StaticInterfaceReport(dll)
        let lines = report.Replace("\r\n", "\n").Split('\n').Where((line string) -> line.Length != 0).ToArray()
        let bad = if mutant == 0 {
            report.Replace("0x00000017", "0x00000018")
        } else if mutant == 1 {
            report.Replace("[ReturnPtrToStack]", "[StackUnderflow]")
        } else if mutant == 2 {
            report.Replace("::AsSpan()", "::Other()")
        } else if mutant == 3 {
            report.Replace("2 Error(s)", "3 Error(s)")
        } else if mutant == 4 {
            report.Replace("Verifying " + dll, "Verifying " + dll + ".other")
        } else if mutant == 5 {
            lines[0] + "\n" + lines[0] + "\n" + lines[2]
        } else if mutant == 6 {
            report + "\nUnhandled tool failure"
        } else if mutant == 7 {
            lines[0] + "\n" + lines[1]
        } else if mutant == 8 {
            lines[0] + "\n" + lines[1] + "\n" + lines[2] + "\n" + lines[2]
        } else if mutant == 9 {
            lines[0] + "\n" + lines[2] + "\n" + lines[1]
        } else if mutant == 10 {
            report.Replace("2 Error(s)", "999999999999999999999999999999 Error(s)")
        } else if mutant == 11 {
            report.Replace("ArgIterator.", "ArgIterator")
        } else if mutant == 12 {
            report.Replace(dll + " : ", dll + ".other : ")
        } else {
            report.Replace("Gsharp.Values.Slice`1::", "Gsharp.Values.Slice`2::")
        }
        Assert.NotEqual(report, bad)
        Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, bad), bad)
    }

    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    @InlineData(int32(4))
    @InlineData(int32(5))
    @InlineData(int32(6))
    @InlineData(int32(7))
    func RuntimeRefLikeReturns_RejectChangedSignatureClosureAndProvenance(mutant int32) {
        let original = typeof(Slice[_]).Assembly.Location
        let report = StaticInterfaceReport(original)
        let directory = Directory.CreateTempSubdirectory("ilverify-runtime-proof-").FullName
        try {
            let dll = Path.Combine(directory, Path.GetFileName(original))
            let bytes = File.ReadAllBytes(original)
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let expectedType = if mutant == 1 {
                "Gsharp.Values.ReadOnlySlice`1"
            } else {
                "Gsharp.Values.Slice`1"
            }
            let expectedName = if mutant == 2 {
                "get_Owner"
            } else {
                "AsSpan"
            }
            let target = md.MethodDefinitions.Single(
                (handle MethodDefinitionHandle) -> {
                    let method = md.GetMethodDefinition(handle)
                    return IlVerifyFilterInFinallyRule.GetTypeName(md, method.GetDeclaringType()) == expectedType &&
                        md.GetString(method.Name) == expectedName
                }
            )
            let method = md.GetMethodDefinition(target)
            if mutant <= 2 || mutant == 7 {
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                        method.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let code = header + if (bytes[header] & uint8(3)) == uint8(2) {
                    1
                } else {
                    int32(bytes[header + 1] >> 4) * 4
                }
                if mutant == 7 {
                    Assert.Equal(uint8(0x28), bytes[code + 18])
                    Array.Copy(BitConverter.GetBytes(MetadataTokens.GetToken(target)), 0, bytes, code + 19, 4)
                } else {
                    Assert.Equal(uint8(2), bytes[code])
                    bytes[code] = uint8(0x14)
                }
            } else if mutant == 3 {
                let byRef = md
                    .MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .First(
                    (candidate MethodDefinition) -> {
                        let signature = md.GetBlobBytes(candidate.Signature)
                        return signature.Length >= 3 &&
                            signature[0] == uint8(0x20) &&
                            signature[1] == uint8(0) &&
                            signature[2] == uint8(0x10)
                    }
                )
                let row = pe.PEHeaders.MetadataStartOffset + md.GetTableMetadataOffset(TableIndex.MethodDef) +
                    (MetadataTokens.GetRowNumber(target) - 1) * md.GetTableRowSize(TableIndex.MethodDef)
                Assert.Equal(
                    2,
                    if md.GetHeapSize(HeapIndex.String) > 65535 {
                        4
                    } else {
                        2
                    }
                )
                let signatureColumn = row + 8 + 2
                let width = if md.GetHeapSize(HeapIndex.Blob) > 65535 {
                    4
                } else {
                    2
                }
                Array.Copy(
                    BitConverter.GetBytes(MetadataTokens.GetHeapOffset(byRef.Signature)),
                    0,
                    bytes,
                    signatureColumn,
                    width
                )
            } else if mutant == 4 {
                let owner = md.GetTypeDefinition(method.GetDeclaringType()).GetFields().First()
                let row = pe.PEHeaders.MetadataStartOffset + md.GetTableMetadataOffset(TableIndex.Field) +
                    (MetadataTokens.GetRowNumber(owner) - 1) * md.GetTableRowSize(TableIndex.Field)
                let flags = BitConverter.ToUInt16(bytes, row) | uint16(FieldAttributes.Static)
                Array.Copy(BitConverter.GetBytes(flags), 0, bytes, row, 2)
            } else {
                let name = if mutant == 5 {
                    md.GetAssemblyDefinition().Name
                } else {
                    md.GetAssemblyReference(md.AssemblyReferences.First()).Name
                }
                let offset = pe.PEHeaders.MetadataStartOffset + md.GetHeapMetadataOffset(HeapIndex.String) +
                    MetadataTokens.GetHeapOffset(name)
                bytes[offset] = uint8('X')
            }
            File.WriteAllBytes(dll, bytes)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace(original, dll)))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0), false)
    @InlineData(int32(1), false)
    @InlineData(int32(3), false)
    @InlineData(int32(2), true)
    func RuntimeRefLikeReturns_RejectWrongProcessOutcome(exitCode int32, stderr bool) {
        let dll = typeof(Slice[_]).Assembly.Location
        let report = StaticInterfaceReport(dll)
        let escaped = report.Replace("'", "'\\''")
        let child = CreateChildProcess(
            "[Console]::Out.Write('${report.Replace("'", "''")}'); " +
                (
                if stderr {
                    "[Console]::Error.Write('failure'); exit $exitCode"
                } else {
                    "exit $exitCode"
                }
            ),
            "printf '%s' '$escaped'; " +
                (
                if stderr {
                    "printf failure >&2; exit $exitCode"
                } else {
                    "exit $exitCode"
                }
            )
        )
        Assert.Throws[XunitException](
            () -> IlVerifier.VerifyCore(
                child.FileName,
                child.ArgumentList.ToArray(),
                dll,
                Array.Empty[string](),
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: nil
            )
        )
    }

    @Fact
    func VerifyCore_RejectsStderrEvenWithCompleteSuccessMarker() {
        let dll = typeof(Slice[_]).Assembly.Location
        let marker = "All Classes and Methods in $dll Verified."
        let child = CreateChildProcess(
            "[Console]::Out.Write('${marker.Replace("'", "''")}'); [Console]::Error.Write('failure')",
            "printf '%s' '${marker.Replace("'", "'\\''")}'; printf failure >&2"
        )
        Assert.Throws[XunitException](
            () -> IlVerifier.VerifyCore(
                child.FileName,
                child.ArgumentList.ToArray(),
                dll,
                Array.Empty[string](),
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: nil
            )
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticInterfaceDispatch_UnlistedRoslynAndGSharpAssemblies_RunAndVerify(gsharp bool) {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[CallAbstract]", report, StringComparison.Ordinal)
            Assert.Contains("[Constrained]", report, StringComparison.Ordinal)
            Assert.True(IlVerifyFalsePositives.OnlyKnown(dll, report), report)
            Assert.Equal(0, RunStandaloneAdapter(dll, report))
            IlVerifier.Verify(dll)
            let context = AssemblyLoadContext("static-interface-${Guid.NewGuid():N}", isCollectible: true)
            try {
                let assembly = context.LoadFromStream(MemoryStream(File.ReadAllBytes(dll)))
                let program = assembly.GetTypes().Single((t Type) -> t.GetMethod("Apply") != nil)
                let plus = assembly.GetTypes().Single((t Type) -> t.Name == "Plus")
                let method = program.GetMethod("Apply") ?? throw XunitException("Apply not emitted")
                Assert.Equal(
                    7,
                    method.MakeGenericMethod(plus).Invoke(nil, []object{Activator.CreateInstance(plus)!!, 3, 4})
                )
            } finally {
                context.Unload()
            }
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    func StaticInterfaceDispatch_UnconstrainedCallInSameMethod_StillFails() {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-invalid-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false)
            let report = StaticInterfaceReport(dll)
            let bytes = File.ReadAllBytes(dll)
            let (codeStart, prefixOffset, callOffset) = StaticInterfaceCallLayout(bytes)
            // Six nops leave the abstract call's offset and token unchanged.

            // A category-wide or method-wide suppression would hide this defect.

            Array.Fill(bytes, uint8(0), codeStart + prefixOffset, 6)
            File.WriteAllBytes(dll, bytes)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
            let error = Assert.Throws[XunitException](() -> IlVerifier.Verify(dll))
            Assert.Contains("[CallAbstract]", error.Message, StringComparison.Ordinal)
            Assert.Contains("[offset 0x${callOffset:X8}]", error.Message, StringComparison.Ordinal)
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    @InlineData(int32(4))
    @InlineData(int32(5))
    @InlineData(int32(6))
    func StaticInterfaceDispatch_RejectsWrongSlotMetadataAndConstraint(mutant int32) {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-metadata-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false)
            let report = StaticInterfaceReport(dll)
            let bytes = File.ReadAllBytes(dll)
            let (codeStart, _, callOffset) = StaticInterfaceCallLayout(bytes)
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let slotHandle = md.MethodDefinitions.Single(
                (h MethodDefinitionHandle) -> md.GetString(md.GetMethodDefinition(h).Name) == "Add" &&
                    (md.GetMethodDefinition(h).Attributes & MethodAttributes.Abstract) != 0
            )
            if mutant < 2 {
                let row = pe.PEHeaders.MetadataStartOffset + md.GetTableMetadataOffset(TableIndex.MethodDef) +
                    (MetadataTokens.GetRowNumber(slotHandle) - 1) * md.GetTableRowSize(TableIndex.MethodDef) + 6
                let flags = BitConverter.ToUInt16(bytes, row)
                let remove = if mutant == 0 {
                    MethodAttributes.Static
                } else {
                    MethodAttributes.Virtual
                }
                let changed = BitConverter.GetBytes(uint16(flags & ~uint16(remove)))
                Array.Copy(changed, 0, bytes, row, 2)
            } else if mutant == 2 {
                // Replace the constrained TypeSpec with a MethodDef token.

                Array.Copy(
                    BitConverter.GetBytes(MetadataTokens.GetToken(slotHandle)),
                    0,
                    bytes,
                    codeStart + callOffset - 4,
                    4
                )
            } else if mutant == 3 {
                // Give T an unrelated class constraint instead of IAdd.

                Assert.Equal(4, md.GetTableRowSize(TableIndex.GenericParamConstraint))
                let unrelated = md.TypeDefinitions.Single(
                    (h TypeDefinitionHandle) -> md.GetString(md.GetTypeDefinition(h).Name) == "P"
                )
                let row = pe.PEHeaders.MetadataStartOffset + md.GetTableMetadataOffset(
                    TableIndex.GenericParamConstraint
                ) +
                    2
                Array.Copy(BitConverter.GetBytes(uint16(MetadataTokens.GetRowNumber(unrelated) << 2)), 0, bytes, row, 2)
            } else {
                let signature = md.GetMethodDefinition(slotHandle).Signature
                let length = md.GetBlobBytes(signature).Length
                Assert.InRange(length, 1, 127)
                let blob = pe.PEHeaders.MetadataStartOffset + md.GetHeapMetadataOffset(HeapIndex.Blob) +
                    MetadataTokens.GetHeapOffset(signature)
                Assert.Equal(uint8(length), bytes[blob])
                Assert.Equal(uint8(0), bytes[blob + 1])
                // HAS_THIS, EXPLICIT_THIS and VARARG are not default static signatures.
                bytes[blob + 1] = if mutant == 4 {
                    uint8(0x20)
                } else if mutant == 5 {
                    uint8(0x40)
                } else {
                    uint8(0x05)
                }
            }
            File.WriteAllBytes(dll, bytes)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    func StaticInterfaceDispatch_RejectsOtherOffsetsErrorsAndUnaccountedOutput() {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-report-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false)
            let report = StaticInterfaceReport(dll)
            let (_, _, callOffset) = StaticInterfaceCallLayout(File.ReadAllBytes(dll))
            Assert.False(
                IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("0x${callOffset:X8}", "0x${callOffset + 1:X8}"))
            )
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("[CallAbstract]", "[StackUnderflow]")))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("2 Error(s)", "3 Error(s)")))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report + "\nError: unparsed verifier failure"))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("::Apply(", "::Missing(")))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticInterfaceDispatch_UnderflowAfterCall_StillFails(successor bool) {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-flow-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false, callerBody: "T.Add(a,b); return 123456789;")
            let bytes = File.ReadAllBytes(dll)
            let (codeStart, _, callOffset) = StaticInterfaceCallLayout(bytes)
            let tail = if successor {
                []uint8{0x26, 0x2B, 0x00, 0x26, 0x16, 0x2A} // pop; br.s L; L: pop; ldc.i4.0; ret

            } else {
                []uint8{0x26, 0x26, 0x16, 0x2A} // pop; pop; ldc.i4.0; ret

            }
            Assert.Equal(uint8(2), bytes[codeStart - 1] & uint8(3))
            let codeSize = callOffset + 5 + tail.Length
            Assert.True(codeSize <= int32(bytes[codeStart - 1] >> 2))
            Array.Copy(tail, 0, bytes, codeStart + callOffset + 5, tail.Length)
            bytes[codeStart - 1] = uint8((codeSize << 2) | 2)
            File.WriteAllBytes(dll, bytes)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[CallAbstract]", report, StringComparison.Ordinal)
            Assert.Contains("[Constrained]", report, StringComparison.Ordinal)
            if successor {
                // The verifier does not import this successor after the false-positive pair.
                Assert.DoesNotContain("[StackUnderflow]", report, StringComparison.Ordinal)
                Assert.Contains("2 Error(s)", report, StringComparison.Ordinal)
            } else {
                // It does continue checking instructions in the current basic block.
                Assert.Contains("[StackUnderflow]", report, StringComparison.Ordinal)
            }
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
            Assert.Throws[XunitException](() -> IlVerifier.Verify(dll))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    func StaticInterfaceDispatch_ExceptionRegionsFailClosed() {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-eh-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(
                dir,
                gsharp: false,
                callerBody: "try { return T.Add(a,b); } finally { System.GC.KeepAlive(w); }"
            )
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[CallAbstract]", report, StringComparison.Ordinal)
            Assert.Contains("[Constrained]", report, StringComparison.Ordinal)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
            Assert.Throws[XunitException](() -> IlVerifier.Verify(dll))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    func StaticInterfaceDispatch_UninstantiatedGenericMethodDefFails() {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-generic-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false, genericSlot: true)
            let bytes = File.ReadAllBytes(dll)
            let (codeStart, _, callOffset) = StaticInterfaceCallLayout(bytes)
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let slot = md.MethodDefinitions.Single(
                (h MethodDefinitionHandle) -> md.GetString(md.GetMethodDefinition(h).Name) == "Add" &&
                    (md.GetMethodDefinition(h).Attributes & MethodAttributes.Abstract) != 0
            )
            Assert.Single(md.GetMethodDefinition(slot).GetGenericParameters())
            Assert.Equal(
                HandleKind.MethodSpecification,
                MetadataTokens.EntityHandle(BitConverter.ToInt32(bytes, codeStart + callOffset + 1)).Kind
            )
            Array.Copy(BitConverter.GetBytes(MetadataTokens.GetToken(slot)), 0, bytes, codeStart + callOffset + 1, 4)
            File.WriteAllBytes(dll, bytes)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[CallAbstract]", report, StringComparison.Ordinal)
            Assert.Contains("[Constrained]", report, StringComparison.Ordinal)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
            Assert.Throws[XunitException](() -> IlVerifier.Verify(dll))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func StandaloneAdapter_RejectsLegacyFilterWaiver(invalidTail bool) {
        let dir = Path.Combine(AppContext.BaseDirectory, "standalone-filter-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileFilterInFinally(dir, invalidTail)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[StackUnderflow]", report, StringComparison.Ordinal)
            Assert.Contains("1 Error(s)", report, StringComparison.Ordinal)
            Assert.Equal(1, RunStandaloneAdapter(dll, report))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func VerifyCore_AcceptsNativeAssemblyWithNoncanonicalPath(relative bool) {
        let tempDir = Path.GetFullPath(Directory.CreateTempSubdirectory("gs_ilv_path_").FullName)
        try {
            Directory.CreateDirectory(Path.Combine(tempDir, "nested"))
            let outPath = Path.Combine(tempDir, "valid.dll")
            let compilation = CSharpCompilation.Create(
                "Valid",
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText("public static class Valid { public static int Value() => 42; }")
                },
                []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let emit = compilation.Emit(outPath)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            IlVerifier.Verify(outPath)
            let noncanonicalPath = Path.Combine(tempDir, ".", "nested", "..", "valid.dll")
            let assemblyPath = if relative {
                Path.GetRelativePath(IlVerifier.FindRepoRoot(), noncanonicalPath)
            } else {
                noncanonicalPath
            }
            Assert.Equal(outPath, Path.GetFullPath(assemblyPath, IlVerifier.FindRepoRoot()))
            Assert.NotEqual(outPath, assemblyPath)
            IlVerifier.VerifyCore(
                "dotnet",
                []string{"tool", "run", "ilverify"},
                assemblyPath,
                []string{typeof(object).Assembly.Location},
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: nil
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0), "")
    @InlineData(int32(0), "All Classes and Methods Verified.")
    @InlineData(int32(0), "All Classes and Methods in other.dll Verified.")
    @InlineData(int32(0), "matching-with-extra-output")
    @InlineData(int32(1), "matching")
    func VerifyCore_RejectsMissingOrWrongMarkerAndNonzeroExit(exitCode int32, output string) {
        let assemblyPath = typeof(IlVerifierTests).Assembly.Location
        let marker = if output == "matching-with-extra-output" {
            "unexpected tool output\nAll Classes and Methods in $assemblyPath Verified."
        } else if output == "matching" {
            "All Classes and Methods in $assemblyPath Verified."
        } else {
            output
        }
        let child = CreateChildProcess(
            "[Console]::Out.Write('${marker.Replace("'", "''")}'); exit $exitCode",
            "printf '%s' '${marker.Replace("'", "'\\''")}'; exit $exitCode"
        )
        let exception = Assert.Throws[XunitException](
            () -> IlVerifier.VerifyCore(
                child.FileName,
                child.ArgumentList.ToArray(),
                assemblyPath,
                Array.Empty[string](),
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: nil
            )
        )
        Assert.Contains(
            if exitCode == 0 {
                "without confirming verification"
            } else {
                "(exit 1)"
            },
            exception.Message,
            StringComparison.Ordinal
        )
    }

    @Theory
    @InlineData(int32(0), "")
    @InlineData(int32(0), "All Classes and Methods Verified.")
    @InlineData(int32(0), "All Classes and Methods in other.dll Verified.")
    @InlineData(int32(1), "matching")
    func CreateChildProcess_WindowsCommandIsInvokedScriptBlock(exitCode int32, output string) {
        const AssemblyPath = "C:\\verifier fixture\\test.dll"
        let marker = if output == "matching" {
            "All Classes and Methods in $AssemblyPath Verified."
        } else {
            output
        }
        let command = "[Console]::Out.Write('${marker.Replace("'", "''")}'); exit $exitCode"
        let child = CreateChildProcess(command, string.Empty, windows: true)
        child.ArgumentList.Add(AssemblyPath)
        child.ArgumentList.Add("-s")
        child.ArgumentList.Add("System.Private.CoreLib")
        Assert.Equal("powershell.exe", child.FileName)
        Assert.Equal(
            []string{
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& { $command }",
                AssemblyPath,
                "-s",
                "System.Private.CoreLib"
            },
            child.ArgumentList.ToArray()
        )
    }

    @Fact
    func Verify_AcceptsValidEmittedAssembly_DoesNotThrow() {
        // Compile the smallest possible gs program and verify the result.
        // This is the actual usage pattern for Compile…Verify() helpers, and
        // guards against regressions in IlVerifier itself (e.g., wrong system
        // module name, missing reference probe).
        let tempDir = Directory.CreateTempSubdirectory("gs_ilv_smoke_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "smoke.gs")
            let outPath = Path.Combine(tempDir, "smoke.dll")
            File.WriteAllText(srcPath, `package P

func Main() {
}
`)
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath), "expected output at $outPath")
            IlVerifier.Verify(outPath)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Verify_MissingAssembly_Throws() {
        let bogus = Path.Combine(Path.GetTempPath(), "does-not-exist-${Guid.NewGuid():N}.dll")
        Assert.Throws[XunitException](() -> IlVerifier.Verify(bogus))
    }

    @Fact
    func Verify_MissingReference_Throws() {
        let bogus = Path.Combine(Directory.GetCurrentDirectory(), "does-not-exist-${Guid.NewGuid():N}.dll")
        let exception = Assert.Throws[XunitException](
            () -> IlVerifier.Verify(typeof(IlVerifierTests).Assembly.Location, []string{bogus})
        )
        Assert.Contains("reference assembly not found", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func Verify_InvalidMethodBody_ReportsErrors() {
        let tempDir = Directory.CreateTempSubdirectory("gs_ilv_bad_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "bad.gs")
            let outPath = Path.Combine(tempDir, "bad.dll")
            File.WriteAllText(srcPath, `package P

public func Bad() {
}
`)
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            Assert.Equal(0, exit)
            let bytes = File.ReadAllBytes(outPath)
            {
                using let peReader = PEReader(MemoryStream(bytes, writable: false))
                let metadata = peReader.GetMetadataReader()
                let method = metadata
                    .MethodDefinitions
                    .Select(metadata.GetMethodDefinition)
                    .Single((m MethodDefinition) -> metadata.GetString(m.Name) == "Bad")
                let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
                Assert.Equal([]uint8{0x2A}, body.GetILBytes())
                let section = peReader
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                        method.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let bodyOffset = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let headerSize = 1
                bytes[bodyOffset + headerSize] = uint8(0x26)
            }
            File.WriteAllBytes(outPath, bytes)
            let exception = Assert.Throws[XunitException](() -> IlVerifier.Verify(outPath))
            Assert.Contains("Error(s)", exception.Message, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Verify_RespectsSkipEnvVar() {
        let prev = Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY")
        Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", "1")
        try {
            // With the gate disabled, even a missing assembly is a no-op so
            // developers can locally bypass the tool requirement.
            let bogus = Path.Combine(Path.GetTempPath(), "does-not-exist-${Guid.NewGuid():N}.dll")
            IlVerifier.Verify(bogus)
            Assert.False(IlVerifier.IsEnabled)
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", prev)
        }
    }

    @Fact
    func Verify_MethodScopedIgnore_DoesNotHideSameErrorInAnotherMethod() {
        let tempDir = Directory.CreateTempSubdirectory("gs_ilv_scope_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "scope.gs")
            let outPath = Path.Combine(tempDir, "scope.dll")
            File.WriteAllText(srcPath, `package P

unsafe func Ignored(p *int32) int32 { return *p }
unsafe func Visible(p *int32) int32 { return *p }`)
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            Assert.Equal(0, exit)
            let exception = Assert.Throws[XunitException](
                () -> IlVerifier.Verify(
                    outPath,
                    ignoredErrorCodes: []string{"UnmanagedPointer", "StackByRef"},
                    ignoredErrorScope: "<Program>\\.Ignored$$"
                )
            )
            Assert.Contains("::Visible(", exception.Message, StringComparison.Ordinal)
            Assert.DoesNotContain("::Ignored(", exception.Message, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func RunProcess_HungChild_TimesOutWithPartialOutput() {
        let assemblyPath = typeof(IlVerifierTests).Assembly.Location
        let stopwatch = Stopwatch.StartNew()
        let exception = Assert.Throws[XunitException](
            func () object? {
                return IlVerifier.RunProcess(
                    CreateChildProcess(
                        "[Console]::Out.Write('timeout-stdout'); [Console]::Error.Write('timeout-stderr'); Start-Sleep -Seconds 6",
                        "printf timeout-stdout; printf timeout-stderr >&2; sleep 6"
                    ),
                    assemblyPath,
                    timeoutMilliseconds: 2_000
                )
            }
        )
        stopwatch.Stop()
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5), "timeout took ${stopwatch.Elapsed}")
        Assert.Contains("timed out after 2000 ms", exception.Message, StringComparison.Ordinal)
        Assert.Contains(assemblyPath, exception.Message, StringComparison.Ordinal)
        Assert.Contains("timeout-stdout", exception.Message, StringComparison.Ordinal)
        Assert.Contains("timeout-stderr", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func RunProcess_LargeStdoutAndStderr_DrainsBothPipes() {
        // A regression that blocks in either drain before WaitForExit hangs this test.
        // Starting a drain after the wait instead reaches the 10 s timeout and fails boundedly.
        // xUnit's Fact timeout is unavailable because this assembly disables test
        // parallelization, and RunProcess's timeout cannot cover a deadlock placed
        // before its wait. Treat such a hang as the regression, not a flake.
        const OutputLength = 128 * 1024
        let result = IlVerifier.RunProcess(
            CreateChildProcess(
                "[Console]::Out.Write('o' * $OutputLength); [Console]::Error.Write('e' * $OutputLength)",
                "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"o\" }'; " +
                    "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"e\" }' >&2"
            ),
            typeof(IlVerifierTests).Assembly.Location,
            timeoutMilliseconds: 10_000
        )
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(String('o', OutputLength), result.Stdout)
        Assert.Equal(String('e', OutputLength), result.Stderr)
    }

    @Fact
    func TryProbe_LargeStdoutAndStderr_DrainsBothPipes() {
        const OutputLength = 128 * 1024
        Assert.True(
            IlVerifier.TryProbe(
                CreateChildProcess(
                    "[Console]::Out.Write('o' * $OutputLength); [Console]::Error.Write('e' * $OutputLength)",
                    "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"o\" }'; " +
                        "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"e\" }' >&2"
                ),
                timeoutMilliseconds: 10_000
            )
        )
    }

    @Fact
    func RunProcess_EscapedDescendantHoldingPipe_TimeoutRemainsBounded() {
        if OperatingSystem.IsWindows() {
            // Process has no portable API for creating a reparented Windows
            // descendant that retains inherited redirected pipe handles.
            return
        }
        let pidPath = Path.Combine(AppContext.BaseDirectory, "ilverify-escaped-${Guid.NewGuid():N}.pid")
        try {
            let stopwatch = Stopwatch.StartNew()
            let exception = Assert.Throws[XunitException](
                func () object? {
                    return IlVerifier.RunProcess(
                        CreateChildProcess(
                            string.Empty,
                            "(sleep 30 2>/dev/null & echo $$! > '$pidPath'); printf escaped-stdout; sleep 6"
                        ),
                        typeof(IlVerifierTests).Assembly.Location,
                        timeoutMilliseconds: 2_000
                    )
                }
            )
            stopwatch.Stop()
            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(20), "timeout took ${stopwatch.Elapsed}")
            Assert.Contains("process '/bin/sh' timed out after 2000 ms", exception.Message, StringComparison.Ordinal)
            Assert.Contains(
                "<unavailable: output pipe held by a surviving descendant>",
                exception.Message,
                StringComparison.Ordinal
            )
        } finally {
            if File.Exists(pidPath) && int32.TryParse(File.ReadAllText(pidPath), out var pid) {
                try {
                    using let escaped = Process.GetProcessById(pid)
                    escaped.Kill(entireProcessTree: true)
                    escaped.WaitForExit(5_000)
                } catch (ArgumentException) { }
            }
            File.Delete(pidPath)
        }
    }

    shared {
        private func CompileFilterInFinally(dir string, invalidTail bool) string {
            let dll = Path.Combine(dir, "filter.dll")
            let compilation = CSharpCompilation.Create("filter", []SyntaxTree{CSharpSyntaxTree.ParseText(`public static class FilterFixture {
public static int Run() {
    try { return 1; }
    finally {
        try { throw new System.Exception(); }
        catch (System.Exception ex) when (ex is System.InvalidOperationException) {}
    }
}
}`)}, []PortableExecutableReference{
                    MetadataReference.CreateFromFile(typeof(object).Assembly.Location)
                }, CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    optimizationLevel: OptimizationLevel.Release
                ))
            let emit = compilation.Emit(dll)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            if invalidTail {
                let bytes = File.ReadAllBytes(dll)
                using let pe = PEReader(MemoryStream(bytes, writable: false))
                let md = pe.GetMetadataReader()
                let method = md
                    .MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single((m MethodDefinition) -> md.GetString(m.Name) == "Run")
                let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                let filter = body.ExceptionRegions.Single((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                let il = body.GetILBytes() ?? throw XunitException("Run has no IL")
                Assert.Equal(uint8(0x75), il[filter.FilterOffset])
                Assert.True(filter.HandlerOffset - filter.FilterOffset >= 10)
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                        method.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                Assert.Equal(uint8(3), bytes[header] & uint8(3))
                let code = header + int32(bytes[header + 1] >> 4) * 4
                Array.Fill(
                    bytes,
                    uint8(0),
                    code + filter.FilterOffset + 5,
                    filter.HandlerOffset - filter.FilterOffset - 5
                )
                // Keep isinst intact, then pop its result and underflow on the second pop.
                bytes[code + filter.FilterOffset + 5] = uint8(0x26)
                bytes[code + filter.FilterOffset + 6] = uint8(0x26)
                bytes[code + filter.HandlerOffset - 3] = uint8(0x16)
                bytes[code + filter.HandlerOffset - 2] = uint8(0xFE)
                bytes[code + filter.HandlerOffset - 1] = uint8(0x11)
                File.WriteAllBytes(dll, bytes)
            }
            return dll
        }

        private func RunStandaloneAdapter(
            dll string,
            report string,
            expectApprovedReturn bool = false,
            expectedAccepted int32 = 2
        ) int32 {
            let adapter = Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "IlVerifyDiagnostics", "IlVerifyDiagnostics.dll")
            )
            Assert.True(File.Exists(adapter), "Standalone adapter was not built: $adapter")
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add(adapter)
            startInfo.ArgumentList.Add(dll)
            if expectApprovedReturn {
                startInfo.ArgumentList.Add("--report")
            }
            using let process = Process.Start(startInfo) ?? throw XunitException("Standalone adapter did not start")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            process.StandardInput.Write(report)
            process.StandardInput.Close()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                throw XunitException("Standalone adapter timed out")
            }
            let output = stdout.GetAwaiter().GetResult()
            if expectApprovedReturn {
                Assert.Contains("raw verifier stdout:", output, StringComparison.Ordinal)
                Assert.Contains("accepted=$expectedAccepted; unexpected=0", output, StringComparison.Ordinal)
                Assert.Contains("dotnet/runtime#129030", output, StringComparison.Ordinal)
            } else {
                Assert.Equal(string.Empty, output)
            }
            Assert.Equal(string.Empty, stderr.GetAwaiter().GetResult())
            return process.ExitCode
        }

        private func CompileStaticInterface(
            dir string,
            gsharp bool,
            callerBody string? = nil,
            genericSlot bool = false
        ) string {
            let dll = Path.Combine(dir, "unlisted.dll")
            if gsharp {
                let source = Path.Combine(dir, "input.gs")
                File.WriteAllText(source, `package P
interface IAdd { shared{func Add(a int32, b int32) int32;} }
class Plus : IAdd { shared { func Add(a int32, b int32) int32 { return a+b } } }
func Apply[T IAdd](w T, a int32, b int32) int32 { return T.Add(a,b) }`)
                Assert.Equal(
                    0,
                    Program.Main([]string{"/out:" + dll, "/target:library", "/targetframework:net10.0", source})
                )
            } else {
                var source = `public interface IAdd { static abstract int Add(int a,int b); }
public class Plus : IAdd { public static int Add(int a,int b) => a+b; }
public class P { public static int Apply<T>(T w,int a,int b) where T:IAdd => T.Add(a,b); }`
                if callerBody != nil {
                    source = source.Replace("=> T.Add(a,b);", "{ " + callerBody + " }")
                }
                if genericSlot {
                    source = source.Replace("int Add(", "int Add<U>(").Replace("T.Add(a,b)", "T.Add<int>(a,b)")
                }
                let compilation = CSharpCompilation.Create(
                    "unlisted",
                    []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                    []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                    CSharpCompilationOptions(
                        OutputKind.DynamicallyLinkedLibrary,
                        optimizationLevel: OptimizationLevel.Release
                    )
                )
                let emit = compilation.Emit(dll)
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            }
            return dll
        }

        private func StaticInterfaceReport(dll string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for arg in[]string{
                "tool",
                "run",
                "ilverify",
                dll,
                "-s",
                "System.Private.CoreLib",
                "-r",
                Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            } {
                startInfo.ArgumentList.Add(arg)
            }
            startInfo.WorkingDirectory = IlVerifier.FindRepoRoot()
            let result = IlVerifier.RunProcess(startInfo, dll, 30_000)
            Assert.Equal(2, result.ExitCode)
            Assert.True(string.IsNullOrWhiteSpace(result.Stderr), result.Stderr)
            return result.Stdout
        }

        private func StaticInterfaceCallLayout(bytes[]uint8)(CodeStart int32, PrefixOffset int32, CallOffset int32) {
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let method = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single((m MethodDefinition) -> md.GetString(m.Name) == "Apply")
            let il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
            let instructions = IlInstructionReader.Read(il)
            let prefix = instructions.Single((i IlInstruction) -> i.OpCode == OpCodes.Constrained)
            let call = instructions.Single((i IlInstruction) -> i.OpCode == OpCodes.Call)
            Assert.Equal(prefix.Offset + 6, call.Offset)
            let section = pe
                .PEHeaders
                .SectionHeaders
                .Single(
                (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                    method.RelativeVirtualAddress < s.VirtualAddress +
                    s.SizeOfRawData
            )
            let header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
            let headerSize = if (bytes[header] & uint8(3)) == uint8(2) {
                1
            } else {
                int32(bytes[header + 1] >> 4) * 4
            }
            return (header + headerSize, prefix.Offset, call.Offset)
        }

        private func CreateChildProcess(
            windowsCommand string,
            unixCommand string,
            windows bool? = nil
        ) ProcessStartInfo {
            let isWindows = windows ?? OperatingSystem.IsWindows()
            let startInfo = ProcessStartInfo(
                if isWindows {
                    "powershell.exe"
                } else {
                    "/bin/sh"
                }
            ){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
            if isWindows {
                startInfo.ArgumentList.Add("-NoProfile")
                startInfo.ArgumentList.Add("-NonInteractive")
                startInfo.ArgumentList.Add("-Command")
                // VerifyCore appends verifier arguments; keep them outside the invoked script.
                startInfo.ArgumentList.Add("& { $windowsCommand }")
            } else {
                startInfo.ArgumentList.Add("-c")
                startInfo.ArgumentList.Add(unixCommand)
            }
            return startInfo
        }
    }
}
