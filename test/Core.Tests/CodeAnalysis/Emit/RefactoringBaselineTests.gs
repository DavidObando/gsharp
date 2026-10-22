// <copyright file="RefactoringBaselineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text.Json
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import System.Reflection
import System.Text
import System.Text.Encodings.Web

/// IL byte-identical gate (PR-0 of the Binder/Emitter decomposition).
///
/// For every `.gs` source in `samples/` and
/// `samples/refactoring-baseline/`, this test compiles the source with
/// deterministic emit enabled, hashes the metadata stream (with the MVID
/// GUID bytes zeroed) plus every method body's IL bytes, and compares the
/// hex SHA-256 digest against the value committed in
/// `test/Core.Tests/Baselines/refactoring-baseline.json`.
///
/// Any "behavior-preserving" extraction PR that quietly changes emitted IL
/// will fail this gate. The fix is to find the divergence in the extraction,
/// not to regenerate the baseline. To regenerate after an intentional IL
/// change, run this test with `GSHARP_UPDATE_GOLDENS=1` (see
/// `test/Core.Tests/Baselines/README.md`).
open class RefactoringBaselineTests {
    @Fact
    func Samples_EmittedPE_Match_Baseline() {
        let repoRoot = LocateRepoRoot() ?? throw InvalidOperationException("Could not locate repository root.")
        let entries = SortedDictionary[string, string?](StringComparer.Ordinal)
        let tables = SortedDictionary[string, SortedDictionary[string, []string]](StringComparer.Ordinal)
        let failures = List[string]()
        // One resolver for the whole loop: building the ref-pack metadata context per sample is pure overhead.
        using let references = SampleReferences.CreateResolver()
        for rel in EnumerateSampleRelativePaths(repoRoot) {
            if KnownCompileFailureSamples.Contains(rel) {
                entries[rel] = nil
                continue
            }
            let absolute = Path.Combine(repoRoot, rel)
            let (success, hash, diagnostics, sampleTables) = TryHashSample(absolute, references)
            if success {
                entries[rel] = hash
                tables[rel] = sampleTables ?? throw InvalidOperationException("no table digest for a compiled sample")
            } else {
                failures.Add("$rel: $diagnostics")
            }
        }
        Assert.True(
            failures.Count == 0,
            "Samples expected to compile failed before the IL baseline could be compared:\n" + string.Join(
                "\n",
                failures
            )
        )
        let baselinePath = Path.Combine(repoRoot, "test", "Core.Tests", "Baselines", BaselineFileName)
        let tablesPath = Path.Combine(
            Path.GetDirectoryName(baselinePath) ??
                throw InvalidOperationException("The baseline path has no directory."),
            TablesFileName
        )
        try {
            GoldenFile.AssertMatches(
                baselinePath,
                SerializeBaseline(entries),
                "IL byte-identical gate failed. Investigate unintended emit drift; " +
                    "accept and commit a regenerated baseline only for an intentional IL change."
            )
        } catch (ex GoldenFileException) {
            // Issue #4665: say which metadata tables moved, as a triage aid. The
            // pattern only suggests a cause; the rows still need inspecting.
            throw GoldenFileException(ex.Message + "\n" + DescribeTableDrift(tablesPath, tables, entries, baselinePath))
        }
        // The table digests accompany the hashes: written together under
        // GSHARP_UPDATE_GOLDENS, and a mismatch here means the digests were not
        // regenerated with the baseline.
        GoldenFile.AssertMatches(
            tablesPath,
            JsonSerializer.Serialize(tables, SerializerOptions) + "\n",
            "The per-table digests behind the IL baseline are stale; regenerate them with the baseline."
        )
    }

    /// Pins the triage output: the table diff names exactly the tables that moved.
    /// It reports which tables changed; it does not decide whether the cause is
    /// the reference set or codegen.
    @Fact
    func MetadataTableDiff_NamesTheTablesThatMoved() {
        let baseline = SortedDictionary[string, []string]{
            [MetadataTableDigest.AssemblyRef] = []string{"System.Private.CoreLib, 10.0.0.0, 7CEC85D7BEA7798E"},
            ["TypeRef"] = []string{"rows=3 sha256=AA"},
            [MetadataTableDigest.MethodBodies] = []string{"rows=2 sha256=BB"}
        }
        let referenceTablesMoved = SortedDictionary[string, []string](baseline){
            [MetadataTableDigest.AssemblyRef] = []string{"System.Runtime, 10.0.0.0, B03F5F7F11D50A3A"},
            ["TypeRef"] = []string{"rows=3 sha256=CC"}
        }
        let bodiesMoved = SortedDictionary[string, []string](baseline){
            [MetadataTableDigest.MethodBodies] = []string{"rows=2 sha256=DD"}
        }
        Assert.Equal(
            []string{"AssemblyRef", "TypeRef"},
            MetadataTableDigest.Diff(baseline, referenceTablesMoved).Select((l string) -> l.Split(':')[0])
        )
        Assert.Equal(
            []string{"MethodBodies"},
            MetadataTableDigest.Diff(baseline, bodiesMoved).Select((l string) -> l.Split(':')[0])
        )
        Assert.Empty(MetadataTableDigest.Diff(baseline, SortedDictionary[string, []string](baseline)))
    }

    /// The sample compilations must not see which assemblies the test host
    /// loaded: the resolver has to be the ref pack plus the bundled G# runtime,
    /// with none of the host's test-only assemblies in it.
    @Fact
    func SampleResolver_DoesNotContainHostLoadedAssemblies() {
        const HostOnly = "GSharp.Core.Tests"
        // Control: the default resolver is built from the host's loaded assemblies.
        Assert.Contains(ReferenceResolver.Default().Assemblies, (a Assembly) -> a.GetName().Name == HostOnly)
        using let resolver = SampleReferences.CreateResolver()
        let names = resolver.Assemblies.Select((a Assembly) -> a.GetName().Name).ToList()
        Assert.DoesNotContain(HostOnly, names)
        Assert.Contains("System.Runtime", names)
        Assert.Contains("Gsharp.Extensions", names)
        Assert.Contains("Gsharp.Runtime.Channels", names)
        Assert.Contains("Gsharp.Runtime.Values", names)
    }

    shared {
        private const BaselineFileName string = "refactoring-baseline.json"
        private const TablesFileName string = "refactoring-baseline-tables.json"
        private let SerializerOptions JsonSerializerOptions = JsonSerializerOptions{
            WriteIndented: true,
            Encoder: JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        }

        /// Samples that currently fail to compile on main. Recorded with a
        /// `null` baseline; documented in
        /// `samples/refactoring-baseline/README.md`.
        private let KnownCompileFailureSamples HashSet[string] = HashSet[string](StringComparer.Ordinal){
            "samples/refactoring-baseline/ClosureCaptureRefTypeField.gs",
            "samples/GsharpExtensionsMixed.gs",
            "samples/GsharpExtensionsOptional.gs",
            "samples/GsharpExtensionsSequences.gs",
            "samples/Timeout.gs"
        }

        private func DescribeTableDrift(
            tablesPath string,
            actual SortedDictionary[string, SortedDictionary[string, []string]],
            entries SortedDictionary[string, string?],
            baselinePath string
        ) string {
            if !File.Exists(tablesPath) || !File.Exists(baselinePath) {
                return "No committed table digests to diff against."
            }
            let expectedTables = JsonSerializer.Deserialize[Dictionary[string, Dictionary[string, []string]]](
                File.ReadAllText(tablesPath)
            ) ??
                Dictionary[string, Dictionary[string, []string]]()
            let expectedHashes = JsonSerializer.Deserialize[Dictionary[string, string?]](
                File.ReadAllText(baselinePath)
            ) ??
                Dictionary[string, string?]()
            let report = StringBuilder("Metadata tables that moved, per sample (a change confined to " + `AssemblyRef/TypeRef/MemberRef with unchanged MethodBodies is LIKELY a reference-set difference; inspect the rows, since a metadata-only emitter change can also retarget them):
`)
            var reported = 0
            for (rel, hash) in entries {
                if hash == nil ||
                    (
                    expectedHashes.TryGetValue(rel, out var old) && string.Equals(old, hash, StringComparison.Ordinal)
                ) {
                    continue
                }
                if !expectedTables.TryGetValue(rel, out var oldTables) {
                    report.Append("  ").Append(rel).Append(": no committed digest\n")
                } else {
                    let moved = MetadataTableDigest.Diff(oldTables, actual[rel])
                    for line in moved {
                        report.Append("  ").Append(rel).Append(" ").Append(line).Append('\n')
                    }
                    if moved.Count == 0 {
                        // Fail-safe: the hash moved but no tracked table did, so the
                        // digest is missing a column. Say so rather than print nothing.
                        report
                            .Append("  ")
                            .Append(rel)
                            .Append(": hash changed but no tracked table moved (digest gap)\n")
                    }
                }
                if (reported += 1) >= 10 {
                    report.Append("  ... (further samples elided; fix the ones above and rerun for the rest)\n")
                    break
                }
            }
            return report.ToString()
        }

        private func TryHashSample(absoluteSamplePath string, references ReferenceResolver)(
            Success bool,
            Hash string,
            Diagnostics string,
            Tables SortedDictionary[string, []string]?
        ) {
            let source = File.ReadAllText(absoluteSamplePath)
            let fileName = Path.GetFileName(absoluteSamplePath)
            let tree = SyntaxTree.Parse(SourceText.From(source, fileName))
            // Issue #4665: an explicit reference set, never ReferenceResolver.Default().
            let compilation = Compilation(references, tree){
                DebugInformation = DebugInformationOptions{Deterministic: true}
            }
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream: peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "GSharp.RefactoringBaseline",
                assemblyVersion: "1.0.0.0"
            )
            if !result.Success {
                let diagnostics = string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
                return (false, string.Empty, diagnostics, nil)
            }
            let bytes = peStream.ToArray()
            let hash = HashEmittedContent(bytes)
            return (true, hash, string.Empty, MetadataTableDigest.Compute(bytes))
        }

        /// Hash the parts of the PE that the gate is supposed to pin: the
        /// metadata stream (modulo the MVID GUID, which is a content-derived
        /// nondeterministic id) and every method body's IL bytes (in MethodDef
        /// order). Deliberately excludes the PE wrapper — headers, section
        /// layout, debug directory, PE checksum, COFF TimeDateStamp — because
        /// those are determined by deterministic content hashes of the IL +
        /// metadata themselves and any drift in them is downstream of, not a
        /// substitute for, "did the emitted code change?"
        private func HashEmittedContent(bytes[]uint8) string {
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let mdReader = pe.GetMetadataReader()
            using let sha = SHA256.Create()
            sha.Initialize()
            let mdStart = pe.PEHeaders.MetadataStartOffset
            let mdSize = pe.PEHeaders.MetadataSize
            // 1. Hash the metadata stream verbatim, but with the MVID GUID
            // overwritten with zero bytes. We locate the MVID by reading its
            // value out of the module-def row and then masking every occurrence
            // inside the metadata stream (the #GUID heap stores it once; the
            // search loop also catches any place a future emitter might
            // embed it again).
            let mdCopy = [mdSize]uint8
            Array.Copy(bytes, mdStart, mdCopy, 0, mdSize)
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
            // 2. Hash every method body's IL bytes in MethodDef table order.
            // PEReader.GetMethodBody handles the tiny vs fat header decode and
            // gives us a stable view of the IL stream.
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

        private func EnumerateSampleRelativePaths(repoRoot string) sequence[string] {
            let topLevel = Path.Combine(repoRoot, "samples")
            if Directory.Exists(topLevel) {
                for file in Directory.EnumerateFiles(topLevel, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(
                    (p string) -> p,
                    StringComparer.Ordinal
                ) {
                    yield ToForwardSlashRelative(repoRoot, file)
                }
            }
            let curated = Path.Combine(repoRoot, "samples", "refactoring-baseline")
            if Directory.Exists(curated) {
                for file in Directory.EnumerateFiles(curated, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(
                    (p string) -> p,
                    StringComparer.Ordinal
                ) {
                    yield ToForwardSlashRelative(repoRoot, file)
                }
            }
        }

        private func ToForwardSlashRelative(repoRoot string, absolutePath string) string {
            let rel = Path.GetRelativePath(repoRoot, absolutePath)
            return rel.Replace(Path.DirectorySeparatorChar, '/')
        }

        private func SerializeBaseline(entries SortedDictionary[string, string?]) string {
            let options = JsonSerializerOptions{
                WriteIndented: true,
                Encoder: JavaScriptEncoder.UnsafeRelaxedJsonEscaping
            }
            return JsonSerializer.Serialize(entries, options) + "\n"
        }

        private func LocateRepoRoot() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(RefactoringBaselineTests).Assembly.Location)!!
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
