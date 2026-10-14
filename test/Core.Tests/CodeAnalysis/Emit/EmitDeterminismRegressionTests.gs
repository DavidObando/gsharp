// <copyright file="EmitDeterminismRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import Xunit

/// Regression guard for issue #598: ensures that programs exercising
/// yield-in-try-finally and closure-to-delegate shapes produce
/// deterministic IL across consecutive (cref:Compilation.Emit)
/// calls within the same process. If future dictionary-iteration changes
/// break emit determinism, these tests will fail loudly.
open class EmitDeterminismRegressionTests {
    /// Compiles `YieldInTryFinally.gs` and `FuncToDelegate.gs`
    /// twice in the same process and asserts that the SHA-256 of the
    /// metadata streams (MVID zeroed) is identical across both emissions.
    @Fact
    func EmitDeterminism_TwoConsecutiveEmitsInSameProcess_ProduceIdenticalIL() {
        let repoRoot = LocateRepoRoot()
        Assert.NotNull(repoRoot)
        let samples = []string{"samples/refactoring-baseline/YieldInTryFinally.gs", "samples/FuncToDelegate.gs"}
        for relativePath in samples {
            let absolutePath = Path.Combine(repoRoot!!, relativePath)
            Assert.True(File.Exists(absolutePath), "Sample file not found: $absolutePath")
            let source = File.ReadAllText(absolutePath)
            using let references = SampleReferences.CreateResolver()
            let hash1 = CompileAndHash(source, Path.GetFileName(absolutePath), references)
            let hash2 = CompileAndHash(source, Path.GetFileName(absolutePath), references)
            Assert.True(
                string.Equals(hash1, hash2, StringComparison.OrdinalIgnoreCase),
                (`Non-deterministic IL detected for '` + "$relativePath" + `' within the same process.
`) + (`  emit 1: ` + "$hash1" + `
`) + (`  emit 2: ` + "$hash2" + `
`) + "This indicates a dictionary-iteration-order regression in the emit pipeline (issue #598)."
            )
        }
    }

    /// A more aggressive variant: compiles each sample 5 times and asserts
    /// all hashes are identical, guarding against GC-compaction-induced
    /// reference-identity hash drift within a single run.
    @Fact
    func EmitDeterminism_FiveConsecutiveEmits_AllIdentical() {
        let repoRoot = LocateRepoRoot()
        Assert.NotNull(repoRoot)
        let samples = []string{"samples/refactoring-baseline/YieldInTryFinally.gs", "samples/FuncToDelegate.gs"}
        for relativePath in samples {
            let absolutePath = Path.Combine(repoRoot!!, relativePath)
            Assert.True(File.Exists(absolutePath), "Sample file not found: $absolutePath")
            let source = File.ReadAllText(absolutePath)
            using let references = SampleReferences.CreateResolver()
            let hashes = [5]string
            for var i = 0; i < 5; i++ {
                hashes[i] = CompileAndHash(source, Path.GetFileName(absolutePath), references)
            }
            let distinct = hashes.Distinct().ToArray()
            Assert.True(
                distinct.Length == 1,
                (`Non-deterministic IL detected for '` + "$relativePath" + `': ` + "${distinct.Length}" + ` distinct hashes across 5 emissions.
`) + (`  hashes: ` + "${string.Join(", ", hashes)}" + `
`) + "This indicates a dictionary-iteration-order regression in the emit pipeline (issue #598)."
            )
        }
    }

    shared {
        private func CompileAndHash(source string, fileName string, references ReferenceResolver) string {
            let tree = SyntaxTree.Parse(SourceText.From(source, fileName))
            let compilation = Compilation(references, tree){
                DebugInformation = DebugInformationOptions{Deterministic: true}
            }
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream: peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "GSharp.DeterminismGuard",
                assemblyVersion: "1.0.0.0"
            )
            Assert.True(
                result.Success,
                "Compilation of '$fileName' failed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            return HashEmittedContent(peStream.ToArray())
        }

        private func HashEmittedContent(bytes[]uint8) string {
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let mdReader = pe.GetMetadataReader()
            using let sha = SHA256.Create()
            sha.Initialize()
            let mdStart = pe.PEHeaders.MetadataStartOffset
            let mdSize = pe.PEHeaders.MetadataSize
            let mdCopy = [mdSize]uint8
            Array.Copy(bytes, mdStart, mdCopy, 0, mdSize)
            // Zero out MVID so the hash is content-only.
            let mvid = mdReader.GetGuid(mdReader.GetModuleDefinition().Mvid)
            if mvid != Guid.Empty {
                let mvidBytes = mvid.ToByteArray()
                var searchStart = 0
                while true {
                    let idx = IndexOf(mdCopy, mvidBytes, searchStart)
                    if idx < 0 {
                        break
                    }
                    for var i = 0; i < mvidBytes.Length; i++ {
                        mdCopy[idx + i] = uint8(0)
                    }
                    searchStart = idx + mvidBytes.Length
                }
            }
            sha.TransformBlock(mdCopy, 0, mdCopy.Length, nil, 0)
            for methodHandle in mdReader.MethodDefinitions {
                let method = mdReader.GetMethodDefinition(methodHandle)
                let rva = method.RelativeVirtualAddress
                if rva == 0 {
                    continue
                }
                let body = pe.GetMethodBody(rva)
                let il = body.GetILBytes()
                if il != nil && il.Length > 0 {
                    sha.TransformBlock(il, 0, il.Length, nil, 0)
                }
            }
            sha.TransformFinalBlock(Array.Empty[uint8](), 0, 0)
            return Convert.ToHexString(sha.Hash!!)
        }

        private func IndexOf(haystack[]uint8, needle[]uint8, start int32) int32 {
            let last = haystack.Length - needle.Length
            for var i = start; i <= last; i++ {
                var match = true
                for var j = 0; j < needle.Length; j++ {
                    if (haystack[i + j] != needle[j]) {
                        match = false
                        break
                    }
                }
                if match {
                    return i
                }
            }
            return -1
        }

        private func LocateRepoRoot() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(EmitDeterminismRegressionTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
