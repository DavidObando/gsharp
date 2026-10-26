// <copyright file="PortablePdbEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Xunit
import MetadataSequencePoint = System.Reflection.Metadata.SequencePoint
import GSharp.Core.CodeAnalysis
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

/// Phase 4 (ADR-0027 §7.7a) acceptance tests for the Portable PDB writer.
/// Compiles a tiny program with (cref:DebugInformationFormat.Portable),
/// reads the produced PDB stream back through
/// (cref:MetadataReaderProvider), and asserts the table contents match
/// the source: one `Document` row per (cref:SyntaxTree), one
/// `MethodDebugInformation` row per `MethodDef`, and at least one
/// visible sequence point anchored at the expected source line.
open class PortablePdbEmitTests {
    @Theory
    @InlineData("let value = <-ch")
    @InlineData("let value = await Task.FromResult(20)")
    func AsyncSpill_DiagnosticOriginDoesNotAddVisibleSteppingStops(suspension string) {
        let source = `package main
import System.Threading.Tasks
async func Pipe(ch chan[int32]) int32 {
    ` + suspension + `
    return value + 1
}
func main() {}
`
        let text = SourceText.From(source, "suspension.gs")
        let compilation = Compilation(SyntaxTree.Parse(text)){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        using let pe = PEReader(peStream)
        let metadata = pe.GetMetadataReader()
        let method = Assert.Single(
            metadata.MethodDefinitions,
            (handle MethodDefinitionHandle) -> metadata.GetString(
                metadata.GetMethodDefinition(handle).Name
            ) == "MoveNext"
        )
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let points = provider
            .GetMetadataReader()
            .GetMethodDebugInformation(MetadataTokens.MethodDebugInformationHandle(MetadataTokens.GetRowNumber(method)))
            .GetSequencePoints()
            .ToArray()
        Assert.NotEmpty(points)
        let suspensionLine = text.GetLineIndex(source.IndexOf(suspension, StringComparison.Ordinal)) + 1
        Assert.Single(
            points.Where((point MetadataSequencePoint) -> !point.IsHidden && point.StartLine == suspensionLine)
        )
        let returnLine = text.GetLineIndex(source.IndexOf("return value", StringComparison.Ordinal)) + 1
        Assert.Contains(points, (point MetadataSequencePoint) -> !point.IsHidden && point.StartLine == returnLine)
    }

    @Fact
    func PdbStream_IsEmpty_WhenFormatIsNone() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs")))
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        Assert.Equal(int64(0), pdbStream.Length)
    }

    @Fact
    func PdbStream_HasValidHeader_WhenFormatIsPortable() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        Assert.True(pdbStream.Length > int64(0))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        // At least one document for main.gs.
        Assert.True(reader.Documents.Count >= 1)
    }

    @Fact
    func Document_HasExpectedNameAndSha256Hash() {
        const source = `package main

func main() {
    let x = 1
}
`
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "hello.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success)
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        let docHandle = reader.Documents.Single()
        let doc = reader.GetDocument(docHandle)
        let name = reader.GetString(doc.Name)
        Assert.Equal("hello.gs", name)
        let hashBytes = reader.GetBlobBytes(doc.Hash)
        var expected[]uint8
        {
            using let sha = SHA256.Create()
            expected = sha.ComputeHash(Encoding.UTF8.GetBytes(source))
        }
        Assert.Equal(expected, hashBytes)
        // GSharp language GUID matches the constant exposed by the emitter.
        let languageGuid = reader.GetGuid(doc.Language)
        Assert.Equal(PortablePdbEmitterTestHelpers.GSharpLanguageGuid, languageGuid)
    }

    @Fact
    func Document_HashMatchesRawFileBytes_IncludingBom() {
        // A debugger computes the source checksum over the exact on-disk bytes
        // (BOM included). The PDB document hash must match those raw bytes — not
        // a re-encoded copy of the decoded text — or on-disk source resolution
        // fails and breakpoints never bind. Use a UTF-8 BOM, which File.ReadAllText
        // strips from the decoded text, to guard the regression.
        let sample = Path.Combine(Path.GetTempPath(), "gs_pdbhash_${Guid.NewGuid():N}.gs")
        let rawBytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(`package main

func main() {
    let x = 1
}
`)).ToArray()
        File.WriteAllBytes(sample, rawBytes)
        try {
            using let peStream = MemoryStream()
            using let pdbStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Load(sample)){
                DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
            }
            let result = compilation.Emit(peStream, pdbStream, nil)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            pdbStream.Position = 0
            using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
            let reader = provider.GetMetadataReader()
            let doc = reader.GetDocument(reader.Documents.Single())
            let pdbHash = reader.GetBlobBytes(doc.Hash)
            var expected[]uint8
            {
                using let sha = SHA256.Create()
                expected = sha.ComputeHash(File.ReadAllBytes(sample))
            }
            Assert.Equal(expected, pdbHash)
        } finally {
            File.Delete(sample)
        }
    }

    @Fact
    func MethodDebugInformation_RowCount_MatchesMethodDef() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success)
        // Read MethodDef count from the PE side.
        peStream.Position = 0
        using let peProvider = PEReader(peStream)
        let peReader = peProvider.GetMetadataReader()
        let peMethodDefCount = peReader.MethodDefinitions.Count
        // Read MethodDebugInformation count from the PDB side.
        pdbStream.Position = 0
        using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let pdbReader = pdbProvider.GetMetadataReader()
        let pdbMethodDebugCount = pdbReader.MethodDebugInformation.Count
        Assert.Equal(peMethodDefCount, pdbMethodDebugCount)
    }

    @Fact
    func MainMethod_HasVisibleSequencePoint_AtExpectedLine() {
        const source = `package main

func main() {
    let x = 42
}
`
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "prog.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success)
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        // Scan every method's debug info for a visible sequence point landing
        // on line 4 (the `let x = 42` line, 1-based).
        var foundLine4 = false
        for handle in reader.MethodDebugInformation {
            let info = reader.GetMethodDebugInformation(handle)
            if info.SequencePointsBlob.IsNil {
                continue
            }
            for point in info.GetSequencePoints() {
                if point.IsHidden {
                    continue
                }
                if point.StartLine == 4 {
                    foundLine4 = true
                    Assert.True(point.StartColumn >= 1)
                    Assert.True(point.Offset >= 0)
                    break
                }
            }
            if foundLine4 {
                break
            }
        }
        Assert.True(foundLine4, "Expected a visible sequence point on source line 4.")
    }

    /// Issue #421 P2-12: Visual Studio and Rider have been reported to bind F5
    /// breakpoints flakily when the first sequence-point record of a method is
    /// the hidden 0xfeefee marker. Every method that emits any visible
    /// sequence point must therefore have a non-hidden first record.
    @Fact
    func EveryMethod_FirstSequencePoint_IsNonHidden_WhenAnyVisible() {
        const source = `package main

func add(a int32, b int32) int32 {
    return a + b
}

func main() {
    let x = 1
    let y = 2
    let z = add(x, y)
}
`
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "prog.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        for handle in reader.MethodDebugInformation {
            let info = reader.GetMethodDebugInformation(handle)
            if info.SequencePointsBlob.IsNil {
                continue
            }
            var first MetadataSequencePoint? = nil
            var anyVisible = false
            for p in info.GetSequencePoints() {
                if first == nil {
                    first = p
                }
                if !p.IsHidden {
                    anyVisible = true
                }
            }
            if anyVisible {
                Assert.NotNull(first)
                Assert.False(
                    first!!.IsHidden,
                    "First sequence point of a method with visible points must not be hidden (issue #421 P2-12)."
                )
            }
        }
    }

    /// Issue #421 P2-12: Compiling an async function used to produce a
    /// MoveNext sequence-points blob whose first record was the synthesised
    /// hidden state-dispatch prologue. With `MethodDebugInformation.Document`
    /// also nil (no point carries a usable document) the encoded blob was
    /// outright invalid — Portable PDB readers mis-parsed the first record as
    /// a document-record marker and threw (cref:System.BadImageFormatException)
    /// ("Invalid handle"). Verify the PDB is now iterable for every method
    /// and any visible first record is non-hidden.
    @Fact
    func AsyncMoveNext_PdbBlob_IsIterable_AndFirstVisibleIsNonHidden() {
        const source = `package main
import System
import System.Threading.Tasks

async func compute() int32 {
    let a = await Task.FromResult(10)
    let b = await Task.FromResult(32)
    return a + b
}

func main() {
}
`
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "async.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let peMeta = peReader.GetMetadataReader()
        var sawMoveNext = false
        for methodHandle in reader.MethodDebugInformation {
            let row = MetadataTokens.GetRowNumber(methodHandle)
            let methodDef = MetadataTokens.MethodDefinitionHandle(row)
            let method = peMeta.GetMethodDefinition(methodDef)
            let name = peMeta.GetString(method.Name)
            if name == "MoveNext" {
                sawMoveNext = true
            }
            let info = reader.GetMethodDebugInformation(methodHandle)
            if info.SequencePointsBlob.IsNil {
                continue
            }
            var first MetadataSequencePoint? = nil
            var anyVisible = false
            // The mere act of iterating must not throw — readers used to fault
            // on the all-hidden / nil-document blob the emitter previously
            // produced for MoveNext.
            for p in info.GetSequencePoints() {
                if first == nil {
                    first = p
                }
                if !p.IsHidden {
                    anyVisible = true
                }
            }
            if anyVisible {
                Assert.NotNull(first)
                Assert.False(
                    first!!.IsHidden,
                    "First sequence point of '$name' must not be hidden when any visible record is present (issue #421 P2-12)."
                )
            }
        }
        Assert.True(sawMoveNext, "Expected at least one MoveNext method in the emitted PE.")
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func CatchHandler_MapsBodyInsteadOfPreviousStatement(topLevel bool) {
        let body = `let before = 0
try {
    let parsed = Int32.Parse("invalid")
} catch (error FormatException) {
    Console.WriteLine(42)
}
Console.WriteLine(before)
`
        let source = "import System\n" + if topLevel {
            body
        } else {
            "func main() {\n" + body + "}\n"
        }
        VerifyProtectedRegionSequencePoints(
            source,
            if topLevel {
                "<Main>$"
            } else {
                "main"
            }
        )
    }

    @Theory
    @InlineData("catch (FormatException)")
    @InlineData("catch")
    @InlineData("catch (error FormatException) when error.Message.Length > 0")
    func CatchAndFinallyPrologues_DoNotInheritTryBodyLocations(catchClause string) {
        let source = `import System
func main() {
    Console.WriteLine(0)
    try {
        let parsed = Int32.Parse("invalid")
    } ` + catchClause + ` {
        Console.WriteLine(42)
    } finally {
        Console.WriteLine(43)
    }
}
`
        VerifyProtectedRegionSequencePoints(source, "main")
    }

    @Fact
    func FinallyHandler_MapsFirstStatementAtEntry() {
        const source = `import System
func main() {
    Console.WriteLine(0)
    try {
        let parsed = Int32.Parse("invalid")
    } finally {
        Console.WriteLine(43)
    }
}
`
        VerifyProtectedRegionSequencePoints(source, "main")
    }

    shared {
        private func VerifyProtectedRegionSequencePoints(source string, methodName string) {
            let text = SourceText.From(source, "exceptions.gs")
            let compilation = Compilation(SyntaxTree.Parse(text)){
                DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
            }
            using let peStream = MemoryStream()
            using let pdbStream = MemoryStream()
            let result = compilation.Emit(peStream, pdbStream, nil)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            peStream.Position = 0
            using let pe = PEReader(peStream)
            let metadata = pe.GetMetadataReader()
            let method = Assert.Single(
                metadata.MethodDefinitions,
                (handle MethodDefinitionHandle) -> metadata.GetString(
                    metadata.GetMethodDefinition(handle).Name
                ) == methodName
            )
            let body = pe.GetMethodBody(metadata.GetMethodDefinition(method).RelativeVirtualAddress)
            Assert.NotEmpty(body.ExceptionRegions)
            pdbStream.Position = 0
            using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
            let pdb = provider.GetMetadataReader()
            let points = pdb
                .GetMethodDebugInformation(
                MetadataTokens.MethodDebugInformationHandle(MetadataTokens.GetRowNumber(method))
            )
                .GetSequencePoints()
                .ToArray()
            Assert.NotEmpty(points)
            let tryLine = text.GetLineIndex(source.IndexOf("let parsed", StringComparison.Ordinal)) + 1
            Assert.Contains(points, (point MetadataSequencePoint) -> !point.IsHidden && point.StartLine == tryLine)
            for region in body.ExceptionRegions {
                let entry = points.Last((point MetadataSequencePoint) -> point.Offset <= region.HandlerOffset)
                if region.Kind == ExceptionRegionKind.Finally {
                    Assert.False(entry.IsHidden)
                } else {
                    Assert.True(entry.IsHidden, "Handler entry inherited source line ${entry.StartLine}.")
                }
                let firstBodyPoint = Assert.Single(
                    points.Where(
                        (point MetadataSequencePoint) -> !point.IsHidden &&
                            point.Offset >= region.HandlerOffset &&
                            point.Offset < region.HandlerOffset +
                            region.HandlerLength
                    )
                        .Take(1)
                )
                let marker = if region.Kind == ExceptionRegionKind.Finally {
                    "Console.WriteLine(43)"
                } else {
                    "Console.WriteLine(42)"
                }
                Assert.Equal(
                    text.GetLineIndex(source.IndexOf(marker, StringComparison.Ordinal)) + 1,
                    firstBodyPoint.StartLine
                )
                if region.Kind == ExceptionRegionKind.Filter {
                    let filterEntry = points.Last((point MetadataSequencePoint) -> point.Offset <= region.FilterOffset)
                    Assert.True(filterEntry.IsHidden, "Filter entry inherited source line ${filterEntry.StartLine}.")
                }
            }
        }

        private const SimpleProgram string = `package main

func main() {
    let x = 1
    let y = 2
    let z = x + y
}
`
    }
}

open class PortablePdbPhase5Tests {
    @Fact
    func Method_With_UserLocals_Emits_LocalScope_And_LocalVariable_Rows() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        Assert.True(reader.LocalScopes.Count >= 1, "expected at least one LocalScope row")
        Assert.True(
            reader.LocalVariables.Count >= 3,
            "expected ≥3 LocalVariable rows for x/y/z, got ${reader.LocalVariables.Count}"
        )
        let localNames = HashSet[string]()
        for lvh in reader.LocalVariables {
            let lv = reader.GetLocalVariable(lvh)
            localNames.Add(reader.GetString(lv.Name))
        }
        Assert.Contains("x", localNames)
        Assert.Contains("y", localNames)
        Assert.Contains("z", localNames)
    }

    @Fact
    func LocalScope_Length_Equals_Method_Body_Size() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        using let pe = PEReader(peStream)
        let peReader = pe.GetMetadataReader()
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let pdbReader = provider.GetMetadataReader()
        for lsh in pdbReader.LocalScopes {
            let scope_ = pdbReader.GetLocalScope(lsh)
            Assert.Equal(0, scope_.StartOffset)
            let method = peReader.GetMethodDefinition(scope_.Method)
            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
            Assert.Equal(body.GetILBytes()!!.Length, scope_.Length)
        }
    }

    @Fact
    func Every_LocalScope_References_A_Root_ImportScope() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        Assert.True(reader.ImportScopes.Count >= 1, "expected a root ImportScope row")
        for lsh in reader.LocalScopes {
            let scope_ = reader.GetLocalScope(lsh)
            Assert.False(scope_.ImportScope.IsNil, "every LocalScope must reference an ImportScope")
        }
    }

    @Fact
    func SequencePoints_Header_References_Method_LocalSignature() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ThreeLocalsProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        using let pe = PEReader(peStream)
        let peReader = pe.GetMetadataReader()
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let pdbReader = provider.GetMetadataReader()
        // Find a method with locals and verify the PDB sequence-point header
        // identifies the same StandaloneSignature row that the PE method body
        // points at via localVariablesSignature.
        var verified = false
        for mdih in pdbReader.MethodDebugInformation {
            let mdi = pdbReader.GetMethodDebugInformation(mdih)
            if mdi.LocalSignature.IsNil {
                continue
            }
            let methodHandle = MetadataTokens.MethodDefinitionHandle(MetadataTokens.GetRowNumber(mdih))
            let method = peReader.GetMethodDefinition(methodHandle)
            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
            Assert.Equal(
                MetadataTokens.GetRowNumber(body.LocalSignature),
                MetadataTokens.GetRowNumber(mdi.LocalSignature)
            )
            verified = true
        }
        Assert.True(verified, "expected at least one method with a non-nil LocalSignature in the PDB header")
    }

    shared {
        private const ThreeLocalsProgram string = `package main

func main() {
    let x = 1
    let y = 2
    let z = x + y
}
`
    }
}

/// Phase 6 (issue #216) acceptance tests for `LocalConstant` PDB rows.
/// A `const`-declared binding with a literal initializer must produce a
/// `LocalConstant` row in the Portable PDB and must NOT occupy an IL slot.
open class PortablePdbLocalConstantTests {
    @Fact
    func Const_Float_Produces_LocalConstant_Row() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ConstFloatProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        Assert.True(
            reader.LocalConstants.Count >= 1,
            "expected ≥1 LocalConstant row, got ${reader.LocalConstants.Count}"
        )
        // Find the PI constant row.
        var piName string? = nil
        var piBlob[]?uint8 = nil
        for handle in reader.LocalConstants {
            let lc = reader.GetLocalConstant(handle)
            let name = reader.GetString(lc.Name)
            if name == "PI" {
                piName = name
                piBlob = reader.GetBlobBytes(lc.Signature)
                break
            }
        }
        Assert.NotNull(piName)
        Assert.NotNull(piBlob)
        // Blob[0] must be ELEMENT_TYPE_R8 (0x0D), followed by 8 bytes of the value.
        Assert.True(piBlob!!.Length >= 9, "expected ≥9 blob bytes for R8 constant, got ${piBlob!!.Length}")
        Assert.Equal(0x0D, int32(piBlob!![0]))
        let encodedValue = BitConverter.ToDouble(piBlob!!, 1)
        Assert.Equal(3.14, encodedValue, precision: 10)
    }

    @Fact
    func Const_Does_Not_Allocate_IL_Slot() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ConstFloatProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let pdbReader = pdbProvider.GetMetadataReader()
        // PI must not appear in LocalVariables (it has no IL slot).
        for handle in pdbReader.LocalVariables {
            let lv = pdbReader.GetLocalVariable(handle)
            Assert.NotEqual("PI", pdbReader.GetString(lv.Name))
        }
    }

    @Fact
    func LocalScope_ConstantList_Anchors_Constant_Range() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ConstFloatProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        // There must be a LocalScope whose constantList points at a valid constant row.
        var found = false
        for handle in reader.LocalScopes {
            let scope_ = reader.GetLocalScope(handle)
            let constantHandle = scope_.GetLocalConstants()
            if !constantHandle.GetEnumerator().MoveNext() {
                continue
            }
            // Scope has at least one constant — verify the PI row is reachable.
            for ch in scope_.GetLocalConstants() {
                let lc = reader.GetLocalConstant(ch)
                let name = reader.GetString(lc.Name)
                if name == "PI" {
                    found = true
                    break
                }
            }
            if found {
                break
            }
        }
        Assert.True(found, "expected a LocalScope whose constantList contains the PI LocalConstant row")
    }

    @Fact
    func Multiple_Const_Types_All_Produce_Rows() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(MultipleConstsProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        let names = HashSet[string]()
        for handle in reader.LocalConstants {
            let lc = reader.GetLocalConstant(handle)
            names.Add(reader.GetString(lc.Name))
        }
        Assert.Contains("A", names)
        Assert.Contains("B", names)
        Assert.Contains("C", names)
    }

    /// Issue #421 (P2-11): a `null` string constant must produce a
    /// well-formed `LocalConstant` blob (`ELEMENT_TYPE_STRING`
    /// followed by the `0xFF` sentinel per Portable PDB spec §II.23.2)
    /// rather than being silently dropped. Drives the private
    /// `EncodeLocalConstantSignature` encoder directly via reflection
    /// because the source language has no surface syntax for a typed
    /// `const` initialised to `nil`.
    @Fact
    func Null_String_Constant_Is_Encoded_As_NullString_Sentinel() {
        let emitter = PortablePdbEmitter(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        let method MethodInfo? = typeof(PortablePdbEmitter).GetMethod(
            "EncodeLocalConstantSignature",
            BindingFlags.Instance | BindingFlags.NonPublic
        )
        Assert.NotNull(method)
        let nullHandle = BlobHandle(method!!.Invoke(emitter, []object? {nil}))
        // The pre-fix code matched `case string str:` (which never matches
        // null) and fell through to `default: return default`, producing a
        // nil BlobHandle that the caller then dropped — so the LocalConstant
        // row never reached the PDB. A non-nil handle here proves the
        // regression is fixed.
        Assert.False(
            nullHandle.IsNil,
            "null constant must produce a non-nil signature blob (regression: previously fell through to default and was dropped)"
        )
        // A sibling non-null string still produces its own distinct blob —
        // confirms the null path didn't accidentally collapse onto the
        // empty-string encoding.
        let emptyHandle = BlobHandle(method!!.Invoke(emitter, []object{string.Empty}))
        Assert.False(emptyHandle.IsNil)
        Assert.NotEqual(nullHandle, emptyHandle)
        // Equal blobs deduplicate through GetOrAddBlob, so two null encodings
        // must round-trip to the same handle — i.e. the encoder is
        // deterministic, not accidentally emitting per-call garbage.
        let secondNullHandle = BlobHandle(method!!.Invoke(emitter, []object? {nil}))
        Assert.Equal(nullHandle, secondNullHandle)
    }

    shared {
        private const ConstFloatProgram string = `package main

func main() {
    const PI = 3.14
    let x = PI + 1.0
}
`

        private const MultipleConstsProgram string = `package main

func main() {
    const A = 1
    const B = true
    const C = "hello"
    let x = A
}
`
    }
}

internal shared class PortablePdbEmitterTestHelpers {
    // Mirror of PortablePdbEmitter.GSharpLanguageGuid for cross-assembly assertion.
    // Kept in sync via the unit test in PortablePdbEmitTests — if the
    // emitter ever reissues the GUID this constant must move with it.
    let GSharpLanguageGuid Guid = Guid("4F4D7B6A-0E33-4C2E-A3D7-2E5F8B7F9C00")

    // Mirror of PortablePdbEmitter's CustomDebugInformation kind GUIDs;
    // used by Phase 6 acceptance tests to look up specific CDI rows.
    let EmbeddedSourceKind Guid = Guid("0E8A571B-6926-466E-B4AD-8AB04611F5FE")

    let SourceLinkKind Guid = Guid("CC110556-A091-4D38-9FEC-25AB9A351A6A")
    let CompilationOptionsKind Guid = Guid("B5FEEC05-8CD0-4A83-96DA-466284BB4BD8")
}

open class PortablePdbPhase6Tests {
    @Fact
    func EmbeddedSource_IsAbsent_When_EmbedAllSources_Is_False() {
        let (_, pdb) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        Assert.Empty(FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind))
    }

    @Fact
    func EmbeddedSource_IsPresent_When_EmbedAllSources_Is_True() {
        let (_, pdb) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable, EmbedAllSources: true})
        let rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind)
        Assert.NotEmpty(rows)
        // Decode the first embedded-source blob: int32 formatMarker, then bytes.
        let blob = pdb.GetBlobBytes(rows[0].Value)
        Assert.True(blob.Length > 4)
        let formatMarker = int32(blob[0]) | (int32(blob[1]) << 8) | (int32(blob[2]) << 16) | (int32(blob[3]) << 24)
        Assert.Equal(0, formatMarker) // Phase 6: uncompressed
        let sourceBytes = [blob.Length - 4]uint8
        Buffer.BlockCopy(blob, 4, sourceBytes, 0, sourceBytes.Length)
        let sourceText = Encoding.UTF8.GetString(sourceBytes)
        Assert.Contains("func main()", sourceText)
    }

    @Fact
    func EmbeddedSource_FormatMarker_Is_Unsigned_Zero_Bytes() {
        // Per ECMA Portable PDB spec § "EmbeddedSource", the format marker is
        // an unsigned 4-byte little-endian integer prefix where 0 means the
        // payload is the raw, uncompressed source. Regression guard for #420
        // (P3-12): ensure the emitter writes the marker via WriteUInt32 so the
        // four leading bytes are exactly 0x00,0x00,0x00,0x00 and the value
        // round-trips as an unsigned integer.
        let (_, pdb) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable, EmbedAllSources: true})
        let rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind)
        Assert.NotEmpty(rows)
        for (_, value) in rows {
            let blob = pdb.GetBlobBytes(value)
            Assert.True(blob.Length >= 4)
            Assert.Equal(0x00, int32(blob[0]))
            Assert.Equal(0x00, int32(blob[1]))
            Assert.Equal(0x00, int32(blob[2]))
            Assert.Equal(0x00, int32(blob[3]))
            let unsignedMarker = uint32(blob[0]) | (uint32(blob[1]) << 8) | (uint32(blob[2]) << 16) | (
                uint32(blob[3]) << 24
            )
            Assert.Equal(0u, unsignedMarker)
        }
    }

    @Fact
    func EmbeddedSource_Parent_Is_A_Document_Row() {
        let (_, pdb) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable, EmbedAllSources: true})
        let rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.EmbeddedSourceKind)
        Assert.NotEmpty(rows)
        for (parent, _) in rows {
            Assert.Equal(HandleKind.Document, parent.Kind)
        }
    }

    @Fact
    func SourceLink_BlobMatches_File_Contents() {
        let sourceLinkPath = Path.Combine(Path.GetTempPath(), "sl-${Guid.NewGuid():N}.json")
        let json = "{ \"documents\": { \"*\": \"https://example.com/raw/*\" } }"
        File.WriteAllText(sourceLinkPath, json)
        try {
            let (_, pdb) = EmitWith(
                DebugInformationOptions{Format: DebugInformationFormat.Portable, SourceLinkFilePath: sourceLinkPath}
            )
            let rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.SourceLinkKind)
            Assert.Single(rows)
            let blob = pdb.GetBlobBytes(rows[0].Value)
            Assert.Equal(File.ReadAllBytes(sourceLinkPath), blob)
            // SourceLink CDI must be parented on the Module row.
            Assert.Equal(HandleKind.ModuleDefinition, rows[0].Parent.Kind)
        } finally {
            File.Delete(sourceLinkPath)
        }
    }

    @Fact
    func SourceLink_IsAbsent_When_No_File_Configured() {
        let (_, pdb) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        Assert.Empty(FindCdi(pdb, PortablePdbEmitterTestHelpers.SourceLinkKind))
    }

    @Fact
    func CompilationOptions_Always_Emitted_With_Compiler_And_Language_Identifiers() {
        let (_, pdb) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        let rows = FindCdi(pdb, PortablePdbEmitterTestHelpers.CompilationOptionsKind)
        Assert.Single(rows)
        let blob = pdb.GetBlobBytes(rows[0].Value)
        let options = DecodeCompilationOptions(blob)
        Assert.Equal("gsc", options["compiler-name"])
        Assert.Equal("GSharp", options["language"])
        Assert.Equal("1.0", options["language-version"])
        Assert.True(options.ContainsKey("compiler-version"))
        Assert.False(string.IsNullOrWhiteSpace(options["compiler-version"]))
        // CompilationOptions CDI must be parented on the Module row.
        Assert.Equal(HandleKind.ModuleDefinition, rows[0].Parent.Kind)
    }

    shared {
        private const SimpleProgram string = `package main

func main() {
    let x = 1
}
`

        private func EmitWith(options DebugInformationOptions)(Pe MemoryStream, Pdb MetadataReader) {
            let peStream = MemoryStream()
            let pdbStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
                DebugInformation = options
            }
            let result = compilation.Emit(peStream, pdbStream, nil)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            pdbStream.Position = 0
            let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
            return (peStream, provider.GetMetadataReader())
        }

        private func FindCdi(reader MetadataReader, kind Guid) List[(Parent EntityHandle, Value BlobHandle)] {
            let matches = List[(EntityHandle, BlobHandle)]()
            for handle in reader.CustomDebugInformation {
                let cdi = reader.GetCustomDebugInformation(handle)
                if reader.GetGuid(cdi.Kind) == kind {
                    matches.Add((cdi.Parent, cdi.Value))
                }
            }
            return matches
        }

        private func DecodeCompilationOptions(blob[]uint8) Dictionary[string, string] {
            // Format: (utf8 name \0 utf8 value \0)*
            let dict = Dictionary[string, string](StringComparer.Ordinal)
            var i = 0
            while i < blob.Length {
                let nameStart = i
                while i < blob.Length && blob[i] != uint8(0) {
                    i++
                }
                let name = Encoding.UTF8.GetString(blob, nameStart, i - nameStart)
                i++ // skip null
                let valueStart = i
                while i < blob.Length && blob[i] != uint8(0) {
                    i++
                }
                let value = Encoding.UTF8.GetString(blob, valueStart, i - valueStart)
                i++ // skip null
                dict[name] = value
            }
            return dict
        }
    }
}

open class PortablePdbPhase7Tests {
    @Fact
    func Portable_Writes_CodeView_And_PdbChecksum_Into_PE_DebugDirectory() {
        let (pe, _) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        let entries = ReadDebugDirectoryEntries(pe)
        Assert.Contains(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView)
        Assert.Contains(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.PdbChecksum)
    }

    @Fact
    func CodeView_PdbPath_Defaults_To_Bare_PdbFileName() {
        let (pe, _) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        using let peReader = PEReader(MemoryStream(pe.ToArray()))
        let cv = peReader.ReadDebugDirectory().Single(
            (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView
        )
        let data = peReader.ReadCodeViewDebugDirectoryData(cv)
        // Default path when /pdb:<path> is not set should be "<asm>.pdb".
        Assert.EndsWith(".pdb", data.Path, StringComparison.Ordinal)
        Assert.DoesNotContain('/', data.Path)
        Assert.DoesNotContain('\\', data.Path)
    }

    @Fact
    func CodeView_PdbPath_Is_Absolute_For_Sidecar_When_PdbFilePath_Is_Relative() {
        // Regression for #421 (P2-8): a relative /pdb:<path> (or a relative
        // /out:<path> that defaults the PDB beside it) used to flow into the
        // CodeView entry verbatim, leaving vsdbg unable to locate the sidecar
        // from its working directory. The emitter must root the path.
        let peStream = MemoryStream()
        let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{
                Format: DebugInformationFormat.Portable,
                PdbFilePath: Path.Combine("relative", "sub", "out.pdb")
            }
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        using let peReader = PEReader(MemoryStream(peStream.ToArray()))
        let cv = peReader.ReadDebugDirectory().Single(
            (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView
        )
        let data = peReader.ReadCodeViewDebugDirectoryData(cv)
        Assert.True(Path.IsPathRooted(data.Path), "expected rooted CodeView path, got: ${data.Path}")
        Assert.EndsWith("out.pdb", data.Path, StringComparison.Ordinal)
    }

    @Fact
    func CodeView_PdbPath_Is_Bare_Filename_For_Embedded_When_PdbFilePath_Has_Directory() {
        // For embedded format the CodeView path is conventionally just the
        // bare ".pdb" file name (no directory) because the consumer reads the
        // PDB blob out of the PE itself. A directory portion would be
        // misleading and inconsistent with csc.
        let peStream = MemoryStream()
        let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{
                Format: DebugInformationFormat.Embedded,
                PdbFilePath: Path.Combine(Path.GetTempPath(), "some", "dir", "embedded.pdb")
            }
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        using let peReader = PEReader(MemoryStream(peStream.ToArray()))
        let cv = peReader.ReadDebugDirectory().Single(
            (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView
        )
        let data = peReader.ReadCodeViewDebugDirectoryData(cv)
        Assert.Equal("embedded.pdb", data.Path)
    }

    @Fact
    func CodeView_Pdb_ContentId_Matches_Sidecar_PdbId() {
        let (pe, pdbBytes) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        using let peReader = PEReader(MemoryStream(pe.ToArray()))
        let cv = peReader.ReadDebugDirectory().Single(
            (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView
        )
        let data = peReader.ReadCodeViewDebugDirectoryData(cv)
        using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(MemoryStream(pdbBytes))
        let pdbReader = pdbProvider.GetMetadataReader()
        let pdbId = pdbReader.DebugMetadataHeader!!.Id
        // Portable PDB content id layout: first 16 bytes = guid, next 4 = stamp.
        let pdbGuid = Guid(pdbId.Slice(0, 16).ToArray())
        Assert.Equal(pdbGuid, data.Guid)
    }

    @Fact
    func PdbChecksum_Algorithm_Is_SHA256_And_Matches_Pdb_Content() {
        let (pe, pdbBytes) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        using let peReader = PEReader(MemoryStream(pe.ToArray()))
        let cs = peReader.ReadDebugDirectory().Single(
            (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.PdbChecksum
        )
        let data = peReader.ReadPdbChecksumDebugDirectoryData(cs)
        Assert.Equal("SHA256", data.AlgorithmName)
        using let sha = SHA256.Create()
        let expected = sha.ComputeHash(pdbBytes)
        Assert.Equal(expected, data.Checksum.ToArray())
    }

    @Fact
    func Reproducible_Entry_Is_Present_When_Deterministic_Is_True() {
        let (pe, _) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable, Deterministic: true})
        let entries = ReadDebugDirectoryEntries(pe)
        Assert.Contains(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.Reproducible)
    }

    @Fact
    func Reproducible_Entry_Is_Absent_When_Deterministic_Is_False() {
        let (pe, _) = EmitWith(DebugInformationOptions{Format: DebugInformationFormat.Portable})
        let entries = ReadDebugDirectoryEntries(pe)
        Assert.DoesNotContain(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.Reproducible)
    }

    @Fact
    func Pdb_DebugDirectory_Entries_Are_Absent_When_DebugFormat_Is_None() {
        let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.None}
        }
        let result = compilation.Emit(peStream, nil, nil)
        Assert.True(result.Success)
        using let peReader = PEReader(MemoryStream(peStream.ToArray()))
        let entries = peReader.ReadDebugDirectory()
        // ManagedPEBuilder may insert a bare Reproducible entry when given a
        // deterministicIdProvider; what must NOT appear are PDB-pointing
        // entries since the caller did not request debug info.
        Assert.DoesNotContain(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView)
        Assert.DoesNotContain(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.PdbChecksum)
        Assert.DoesNotContain(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb)
    }

    @Fact
    func Embedded_Format_Writes_EmbeddedPortablePdb_Entry_And_Suppresses_Sidecar() {
        let peStream = MemoryStream()
        let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Embedded}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        // Embedded format must not produce sidecar bytes even if the caller
        // passed a stream — Roslyn behaves the same way.
        Assert.Equal(int64(0), pdbStream.Length)
        using let peReader = PEReader(MemoryStream(peStream.ToArray()))
        let entries = peReader.ReadDebugDirectory()
        Assert.Contains(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb)
        Assert.Contains(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.CodeView)
        Assert.Contains(entries, (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.PdbChecksum)
    }

    @Fact
    func Embedded_Portable_Pdb_Roundtrips_With_Original_Documents() {
        let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Embedded}
        }
        let result = compilation.Emit(peStream, nil, nil)
        Assert.True(result.Success)
        using let peReader = PEReader(MemoryStream(peStream.ToArray()))
        let embed = peReader.ReadDebugDirectory().Single(
            (e DebugDirectoryEntry) -> e.Type == DebugDirectoryEntryType.EmbeddedPortablePdb
        )
        using let pdbProvider = peReader.ReadEmbeddedPortablePdbDebugDirectoryData(embed)
        let pdbReader = pdbProvider.GetMetadataReader()
        Assert.Equal(1, int32(pdbReader.Documents.Count))
        let doc = pdbReader.GetDocument(pdbReader.Documents.First())
        Assert.Equal("main.gs", pdbReader.GetString(doc.Name))
        Assert.Equal(PortablePdbEmitterTestHelpers.GSharpLanguageGuid, pdbReader.GetGuid(doc.Language))
    }

    shared {
        private const SimpleProgram string = `package main

func main() {
    let x = 1
}
`

        private func EmitWith(options DebugInformationOptions)(Pe MemoryStream, PdbBytes[]uint8) {
            let peStream = MemoryStream()
            let pdbStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
                DebugInformation = options
            }
            let result = compilation.Emit(peStream, pdbStream, nil)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            return (peStream, pdbStream.ToArray())
        }

        private func ReadDebugDirectoryEntries(pe MemoryStream) ImmutableArray[DebugDirectoryEntry] {
            using let peReader = PEReader(MemoryStream(pe.ToArray()))
            return peReader.ReadDebugDirectory()
        }
    }
}

/// Issue #217: per-file `ImportScope` chain tests. Verifies that explicit
/// namespace imports in a GSharp source file are encoded into `ImportScope`
/// blobs that debuggers can use to resolve unqualified type names.
open class PortablePdbPhase217Tests {
    @Fact
    func ImportScope_Blob_Contains_Namespace_For_Explicit_Import() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithImports, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        // Expect at least two ImportScope rows: the root (empty) + one per-file scope.
        Assert.True(reader.ImportScopes.Count >= 2, "expected ≥2 ImportScope rows, got ${reader.ImportScopes.Count}")
        // At least one non-root scope must decode to a namespace import for System.Collections.Generic.
        var foundNamespace = false
        for handle in reader.ImportScopes {
            let scope_ = reader.GetImportScope(handle)
            for import_ in scope_.GetImports() {
                if import_.Kind == ImportDefinitionKind.ImportNamespace {
                    let ns = Encoding.UTF8.GetString(reader.GetBlobBytes(import_.TargetNamespace))
                    if ns == "System.Collections.Generic" {
                        foundNamespace = true
                        break
                    }
                }
            }
            if foundNamespace {
                break
            }
        }
        Assert.True(
            foundNamespace,
            "expected an ImportScope row whose blob contains a namespace import for System.Collections.Generic"
        )
    }

    @Fact
    func ImportScope_Blob_Contains_Alias_And_Namespace_For_Alias_Import() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithAliasImport, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        Assert.True(reader.ImportScopes.Count >= 2, "expected ≥2 ImportScope rows, got ${reader.ImportScopes.Count}")
        var foundAlias = false
        for handle in reader.ImportScopes {
            let scope_ = reader.GetImportScope(handle)
            for import_ in scope_.GetImports() {
                if import_.Kind == ImportDefinitionKind.AliasNamespace {
                    let alias = Encoding.UTF8.GetString(reader.GetBlobBytes(BlobHandle(import_.Alias)))
                    let ns = Encoding.UTF8.GetString(reader.GetBlobBytes(import_.TargetNamespace))
                    if alias == "gen" && ns == "System.Collections.Generic" {
                        foundAlias = true
                        break
                    }
                }
            }
            if foundAlias {
                break
            }
        }
        Assert.True(
            foundAlias,
            "expected an ImportScope row whose blob contains AliasNamespace(gen → System.Collections.Generic)"
        )
    }

    @Fact
    func Every_LocalScope_References_The_Per_Tree_ImportScope() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithImports, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        // Find the per-file scope (a scope whose parent is not nil).
        var perFileScope = default(ImportScopeHandle)
        for handle in reader.ImportScopes {
            let scope_ = reader.GetImportScope(handle)
            if !scope_.Parent.IsNil {
                perFileScope = handle
                break
            }
        }
        Assert.False(perFileScope.IsNil, "expected at least one per-file ImportScope (with a non-nil parent)")
        // Every LocalScope that references an ImportScope should reference
        // the per-file scope, not the root.
        for lsh in reader.LocalScopes {
            let ls = reader.GetLocalScope(lsh)
            Assert.False(ls.ImportScope.IsNil, "every LocalScope must reference an ImportScope")
            Assert.Equal(perFileScope, ls.ImportScope)
        }
    }

    @Fact
    func Program_With_No_Explicit_Imports_Still_Produces_Root_ImportScope_Only() {
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(ProgramWithNoExplicitImports, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let result = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
        pdbStream.Position = 0
        using let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let reader = provider.GetMetadataReader()
        // Without explicit imports there is only the single root scope.
        Assert.Equal(1, int32(reader.ImportScopes.Count))
        for lsh in reader.LocalScopes {
            let ls = reader.GetLocalScope(lsh)
            Assert.False(ls.ImportScope.IsNil, "every LocalScope must reference an ImportScope")
        }
    }

    shared {
        private const ProgramWithImports string = `package main

import System.Collections.Generic

func main() {
    let x = 1
    let y = 2
    let z = x + y
}
`

        private const ProgramWithAliasImport string = `package main

import gen = System.Collections.Generic

func main() {
    let x = 1
}
`

        private const ProgramWithNoExplicitImports string = `package main

func main() {
    let x = 1
}
`
    }
}

/// Issue #219: `CompilationMetadataReferences`
/// `CustomDebugInformation` acceptance tests. Verifies that a CDI row
/// keyed on `7E4D4708-096E-4C5C-AEDA-CB10BA6A740D` is written at the
/// module level, and that the blob contains one record per file-backed
/// reference with the expected layout and correct MVID.
open class PortablePdbPhase219Tests {
    @Fact
    func CompilationMetadataReferences_CDI_Is_Emitted_As_Module_Level_Row() {
        let (_, pdb) = EmitWithDefault()
        let rows = FindCdi(pdb, CompilationMetadataReferencesKind)
        Assert.NotEmpty(rows)
        Assert.All(
            rows,
            (row(Parent EntityHandle, Value BlobHandle)) -> Assert.Equal(HandleKind.ModuleDefinition, row.Parent.Kind)
        )
    }

    @Fact
    func CompilationMetadataReferences_Blob_Contains_SystemConsole_With_Matching_Mvid() {
        // System.Console is always loaded by the Default() resolver via
        // WellKnownBclAssemblyNames. Skip the test on environments where the
        // assembly has no on-disk location (e.g. single-file publish).
        let consolePath = typeof(Console).Assembly.Location
        if string.IsNullOrEmpty(consolePath) || !File.Exists(consolePath) {
            return
        }
        let (_, pdb) = EmitWithDefault()
        let rows = FindCdi(pdb, CompilationMetadataReferencesKind)
        Assert.NotEmpty(rows)
        let blob = pdb.GetBlobBytes(rows[0].Value)
        let records = DecodeReferenceRecords(blob)
        // The blob must contain a record for System.Console.dll.
        let consoleRecord = records.FirstOrDefault(
            (r RefRecord) -> r.FileName.EndsWith("System.Console.dll", StringComparison.OrdinalIgnoreCase)
        )
        Assert.NotNull(consoleRecord.FileName)
        // Its MVID must match the MVID read directly from the PE file.
        var expectedMvid Guid
        {
            using let fs = FileStream(consolePath, FileMode.Open, FileAccess.Read, FileShare.Read)
            {
                using let peReader = PEReader(fs)
                let mdReader = peReader.GetMetadataReader()
                let module = mdReader.GetModuleDefinition()
                expectedMvid = mdReader.GetGuid(module.Mvid)
            }
        }
        Assert.Equal(expectedMvid, consoleRecord.Mvid)
    }

    @Fact
    func CompilationMetadataReferences_Record_Flags_Mark_Assembly_Kind() {
        let consolePath = typeof(Console).Assembly.Location
        if string.IsNullOrEmpty(consolePath) || !File.Exists(consolePath) {
            return
        }
        let (_, pdb) = EmitWithDefault()
        let rows = FindCdi(pdb, CompilationMetadataReferencesKind)
        let blob = pdb.GetBlobBytes(rows[0].Value)
        let records = DecodeReferenceRecords(blob)
        // Every record must have bit 1 set (MetadataImageKind.Assembly = 0x02).
        Assert.All(records, (r RefRecord) -> Assert.Equal(0x02, int32(r.Flags) & 0x02))
    }

    private data struct RefRecord(
        FileName string,
        Aliases string,
        Flags uint8,
        TimeStamp uint32,
        FileSize uint32,
        Mvid Guid
    ) : IEquatable[RefRecord] { }

    shared {
        let CompilationMetadataReferencesKind Guid = Guid("7E4D4708-096E-4C5C-AEDA-CB10BA6A740D")

        private const SimpleProgram string = `package main

func main() {
    let x = 1
}
`

        private func EmitWithDefault()(Pe MemoryStream, Pdb MetadataReader) {
            let peStream = MemoryStream()
            let pdbStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(SimpleProgram, "main.gs"))){
                DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
            }
            let result = compilation.Emit(peStream, pdbStream, nil)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            pdbStream.Position = 0
            let provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
            return (peStream, provider.GetMetadataReader())
        }

        private func FindCdi(reader MetadataReader, kind Guid) List[(Parent EntityHandle, Value BlobHandle)] {
            let matches = List[(EntityHandle, BlobHandle)]()
            for handle in reader.CustomDebugInformation {
                let cdi = reader.GetCustomDebugInformation(handle)
                if reader.GetGuid(cdi.Kind) == kind {
                    matches.Add((cdi.Parent, cdi.Value))
                }
            }
            return matches
        }

        private func DecodeReferenceRecords(blob[]uint8) List[RefRecord] {
            let records = List[RefRecord]()
            var i = 0
            while i < blob.Length {
                let fileName = ReadNullTerminatedUtf8(blob, &i)
                let aliases = ReadNullTerminatedUtf8(blob, &i)
                let flags = blob[i++]
                let timeStamp = BitConverter.ToUInt32(blob, i)
                i += 4
                let fileSize = BitConverter.ToUInt32(blob, i)
                i += 4
                let mvidBytes = [16]uint8
                Buffer.BlockCopy(blob, i, mvidBytes, 0, 16)
                i += 16
                records.Add(RefRecord(fileName, aliases, flags, timeStamp, fileSize, Guid(mvidBytes)))
            }
            return records
        }

        private func ReadNullTerminatedUtf8(blob[]uint8, ref i int32) string {
            let start = i
            while i < blob.Length && blob[i] != uint8(0) {
                i++
            }
            let s = Encoding.UTF8.GetString(blob, start, i - start)
            i++ // skip null terminator
            return s
        }
    }
}
