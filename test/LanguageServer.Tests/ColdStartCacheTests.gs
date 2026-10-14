// <copyright file="ColdStartCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.LanguageServer
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import Xunit

/// Tests for (cref:ColdStartCache) (ADR-0107, revised): single-text-file
/// save/load round-trip, the conservative `.rsp`-independent fingerprint,
/// corruption/missing-file fallback, the opt-out switch, and — the headline new
/// capability — bootstrapping the reference set from the cache when no `.rsp`
/// is present (fresh clone / after `dotnet clean`). Correctness here means:
/// never load a stale or corrupt payload, never resolve against a changed/missing
/// reference set (under-invalidation would be a correctness bug), and never throw
/// into the LSP pipeline.
class ColdStartCacheTests : IDisposable {
    private let root string
    private let projectFilePath string
    private let assemblyName string = "Sample"

    init() {
        // Keep scratch dirs under the test output directory (never /tmp).
        root = Path.Combine(AppContext.BaseDirectory, "lscache-tests", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        projectFilePath = Path.Combine(root, assemblyName + ".gsproj")
        File.WriteAllText(
            projectFilePath,
            "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>"
        )
    }

    func Dispose() {
        try {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        } catch (IOException) { }
    }

    private func DescriptorPath() string -> ColdStartCache.DescriptorPath(projectFilePath, assemblyName)

    private func MakeRefFile(name string, content string) string {
        let path = Path.Combine(root, name)
        File.WriteAllText(path, content)
        return path
    }

    @Fact
    func Save_Then_Load_RoundTrips_The_Index() {
        let refA = MakeRefFile("a.dll", "aaa")
        let refs = []string{refA}
        let rsp = MakeRefFile("Sample.rsp", "/r:a.dll")
        let index = SampleIndex()
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rsp, "srcfp", "net8.0", index)
        Assert.True(File.Exists(DescriptorPath()))
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rsp,
            "srcfp",
            "net8.0"
        )
        Assert.NotNull(loaded)
        Assert.True(index.AssemblyIdentities.SequenceEqual(loaded!!.AssemblyIdentities))
        Assert.Equal(index.ToNameIndex().Count, loaded!!.ToNameIndex().Count)
    }

    @Fact
    func Only_One_Cache_File_Is_Written_No_Binary_Sibling() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        let produced = Directory.GetFiles(root, "*.lscache*")
        Assert.Single(produced)
        Assert.EndsWith(".gsproj.lscache", produced[0])
        Assert.Empty(Directory.GetFiles(root, "*.lscache.bin"))
    }

    @Fact
    func Descriptor_Is_Human_Readable_With_Header_Comment_Committable_Note_And_OptOut() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        let text = File.ReadAllText(DescriptorPath())
        Assert.StartsWith("version=", text)
        Assert.Contains("#", text)
        Assert.Contains("[project]", text)
        Assert.Contains("[fingerprint]", text)
        Assert.Contains("[references]", text)
        Assert.Contains("[metadataIndex]", text)
        Assert.Contains("GSHARP_DISABLE_COLD_START_CACHE", text)
        Assert.Contains("commit", text) // committable opt-in note
        Assert.Contains("targetFramework=net8.0", text)
    }

    @Fact
    func Load_Returns_Null_When_References_Change() {
        let refA = MakeRefFile("a.dll", "aaa")
        ColdStartCache.Save(
            projectFilePath,
            assemblyName,
            []string{refA},
            rspPath: nil,
            "srcfp",
            "net8.0",
            SampleIndex()
        )
        let refB = MakeRefFile("b.dll", "bbb")
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            []string{refA, refB},
            rspPath: nil,
            "srcfp",
            "net8.0"
        )
        Assert.Null(loaded)
    }

    @Fact
    func Load_Returns_Null_When_A_Reference_Is_Touched() {
        let refA = MakeRefFile("a.dll", "aaa")
        let refs = []string{refA}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        Thread.Sleep(10)
        File.WriteAllText(refA, "aaaa-modified")
        File.SetLastWriteTimeUtc(refA, DateTime.UtcNow.AddSeconds(5.0))
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rspPath: nil,
            "srcfp",
            "net8.0"
        )
        Assert.Null(loaded)
    }

    @Fact
    func Load_Returns_Null_When_Source_Fingerprint_Changes() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp-v1", "net8.0", SampleIndex())
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rspPath: nil,
            "srcfp-v2",
            "net8.0"
        )
        Assert.Null(loaded)
    }

    @Fact
    func Load_Returns_Null_When_Target_Framework_Changes() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rspPath: nil,
            "srcfp",
            "net9.0"
        )
        Assert.Null(loaded)
    }

    @Fact
    func Load_Survives_An_Rsp_Rebuild_Because_The_Rsp_Is_Not_In_The_Fingerprint() {
        // The .rsp is an ephemeral obj/ artifact; a clean/clone removes it. The
        // fingerprint deliberately excludes it, so touching/rebuilding the .rsp
        // (without changing the resolved reference set) must NOT invalidate.
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        let rsp = MakeRefFile("Sample.rsp", "/r:a.dll")
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rsp, "srcfp", "net8.0", SampleIndex())
        Thread.Sleep(10)
        File.SetLastWriteTimeUtc(rsp, DateTime.UtcNow.AddSeconds(5.0))
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rsp,
            "srcfp",
            "net8.0"
        )
        Assert.NotNull(loaded)
        // And it loads identically with no .rsp at all.
        let loadedNoRsp ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rspPath: nil,
            "srcfp",
            "net8.0"
        )
        Assert.NotNull(loadedNoRsp)
    }

    @Fact
    func Load_Returns_Null_When_Index_Section_Is_Corrupt() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        // Flip a type-name in the [metadataIndex] section: it still parses
        // structurally, but the recorded index SHA-256 no longer matches.
        let path = DescriptorPath()
        let text = File.ReadAllText(path)
        let corrupted = text.Replace(
            "GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver",
            "GSharp.Core.CodeAnalysis.Symbols.ReferenceXesolver"
        )
        Assert.NotEqual(text, corrupted)
        File.WriteAllText(path, corrupted)
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rspPath: nil,
            "srcfp",
            "net8.0"
        )
        Assert.Null(loaded)
    }

    @Fact
    func Load_Returns_Null_When_File_Is_Missing() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        Assert.Null(ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0"))
    }

    @Fact
    func Deleting_Cache_File_Is_Safe() {
        let refs = []string{MakeRefFile("a.dll", "aaa")}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        File.Delete(DescriptorPath())
        Assert.Null(ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0"))
        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName))
    }

    @Fact
    func OptOut_Writes_Nothing_And_Loads_Nothing() {
        const varName = "GSHARP_DISABLE_COLD_START_CACHE"
        let previous string? = Environment.GetEnvironmentVariable(varName)
        try {
            Environment.SetEnvironmentVariable(varName, "1")
            Assert.True(ColdStartCache.Disabled)
            let refs = []string{MakeRefFile("a.dll", "aaa")}
            ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
            Assert.False(File.Exists(DescriptorPath()))
            Assert.Null(ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0"))
            Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName))
        } finally {
            Environment.SetEnvironmentVariable(varName, previous)
        }
    }

    @Fact
    func Loaded_Index_Is_Adoptable_By_A_Fresh_Resolver() {
        let corePath = typeof(ReferenceResolver).Assembly.Location
        let refs = []string{corePath}
        {
            using let producer = ReferenceResolver.WithReferences(refs)
            ColdStartCache.Save(
                projectFilePath,
                assemblyName,
                refs,
                rspPath: nil,
                "srcfp",
                "net8.0",
                producer.ExportMetadataIndex()
            )
        }
        let loaded ReferenceMetadataIndex? = ColdStartCache.TryLoad(
            projectFilePath,
            assemblyName,
            refs,
            rspPath: nil,
            "srcfp",
            "net8.0"
        )
        Assert.NotNull(loaded)
        using let consumer = ReferenceResolver.WithReferences(refs)
        Assert.True(consumer.TryUseMetadataIndex(loaded!!))
        Assert.True(consumer.TryResolveType("System.String", out var stringType))
        Assert.Equal("System.String", stringType.FullName)
    }

    @Fact
    func TryBootstrapReferences_Returns_Validated_Set() {
        let refA = MakeRefFile("a.dll", "aaa")
        let refB = MakeRefFile("b.dll", "bbbb")
        let refs = []string{refA, refB}
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: nil, "srcfp", "net8.0", SampleIndex())
        let bootstrapped IReadOnlyList[string]? = ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName)
        Assert.NotNull(bootstrapped)
        Assert.Equal([]string{refA, refB}, bootstrapped)
    }

    @Fact
    func TryBootstrapReferences_Returns_Null_When_A_Reference_Is_Missing() {
        let refA = MakeRefFile("a.dll", "aaa")
        ColdStartCache.Save(
            projectFilePath,
            assemblyName,
            []string{refA},
            rspPath: nil,
            "srcfp",
            "net8.0",
            SampleIndex()
        )
        File.Delete(refA)
        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName))
    }

    @Fact
    func TryBootstrapReferences_Returns_Null_When_A_Reference_Changed() {
        let refA = MakeRefFile("a.dll", "aaa")
        ColdStartCache.Save(
            projectFilePath,
            assemblyName,
            []string{refA},
            rspPath: nil,
            "srcfp",
            "net8.0",
            SampleIndex()
        )
        Thread.Sleep(10)
        File.WriteAllText(refA, "changed-content")
        File.SetLastWriteTimeUtc(refA, DateTime.UtcNow.AddSeconds(5.0))
        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName))
    }

    @Fact
    func ProjectState_WarmFromCache_Produces_Diagnostics_Identical_To_Cold() {
        const source = `import System
func main() {
Console.WriteLine("hi")
}
`
        let corePath = typeof(ReferenceResolver).Assembly.Location
        let sourcePath = Path.Combine(root, "Program.gs")
        File.WriteAllText(sourcePath, source)
        // Cold run: no cache present yet -> a from-scratch build that also writes
        // the cache. This is the correctness oracle.
        let coldDiagnostics = AnalyzeDiagnostics([]string{corePath}, rspPath: nil, sourcePath)
        // The cache must now exist on disk.
        Assert.True(File.Exists(DescriptorPath()))
        // Warm run: a fresh ProjectState over the same inputs loads the cache.
        let warmDiagnostics = AnalyzeDiagnostics([]string{corePath}, rspPath: nil, sourcePath)
        Assert.Equal(coldDiagnostics, warmDiagnostics)
    }

    @Fact
    func ProjectState_BootstrapsReferences_From_Cache_When_Rsp_Absent() {
        const source = `import System
func main() {
Console.WriteLine("hi")
}
`
        let corePath = typeof(ReferenceResolver).Assembly.Location
        let sourcePath = Path.Combine(root, "Program.gs")
        File.WriteAllText(sourcePath, source)
        // 1) A normal .rsp-backed build resolves references and writes the cache.
        let rspBackedDiagnostics = AnalyzeDiagnostics([]string{corePath}, rspPath: nil, sourcePath)
        Assert.True(File.Exists(DescriptorPath()))
        // 2) Simulate `dotnet clean` / a fresh clone: the .rsp is gone and the LSP
        //    discovers EMPTY references. With the committed/retained .lscache, the
        //    project bootstraps its reference set from the cache and resolves the
        //    imported types -> diagnostics identical to the .rsp-backed build.
        //    (Proven directly: the cache supplies the reference set.)
        let bootstrapped IReadOnlyList[string]? = ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName)
        Assert.NotNull(bootstrapped)
        Assert.Contains(corePath, bootstrapped!!)
        let bootstrapDiagnostics = AnalyzeDiagnostics(Array.Empty[string](), rspPath: nil, sourcePath)
        Assert.Equal(rspBackedDiagnostics, bootstrapDiagnostics)
        // 3) Safe fallback: if a referenced DLL is missing/changed (or the cache is
        //    gone), the bootstrap refuses to supply a stale reference set and the
        //    LSP degrades to today's empty-reference behavior rather than resolving
        //    against the wrong DLLs.
        File.Delete(DescriptorPath())
        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName))
    }

    private func AnalyzeDiagnostics(references IReadOnlyList[string], rspPath string?, sourcePath string) List[string] {
        let project = ProjectState(projectFilePath){
            AssemblyName = assemblyName,
            ReferenceSourcePath = rspPath,
            References = references
        }
        project.AddFileFromDisk(sourcePath)
        let compilation = project.GetCompilation()
        return compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
            .OrderBy((s string) -> s, StringComparer.Ordinal)
            .ToList()
    }

    shared {
        private func SampleIndex() ReferenceMetadataIndex {
            let corePath = typeof(ReferenceResolver).Assembly.Location
            using let resolver = ReferenceResolver.WithReferences([]string{corePath})
            return resolver.ExportMetadataIndex()
        }
    }
}
