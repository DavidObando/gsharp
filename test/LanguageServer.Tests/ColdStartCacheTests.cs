// <copyright file="ColdStartCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.LanguageServer;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Tests for <see cref="ColdStartCache"/> (ADR-0107, revised): single-text-file
/// save/load round-trip, the conservative <c>.rsp</c>-independent fingerprint,
/// corruption/missing-file fallback, the opt-out switch, and — the headline new
/// capability — bootstrapping the reference set from the cache when no <c>.rsp</c>
/// is present (fresh clone / after <c>dotnet clean</c>). Correctness here means:
/// never load a stale or corrupt payload, never resolve against a changed/missing
/// reference set (under-invalidation would be a correctness bug), and never throw
/// into the LSP pipeline.
/// </summary>
public sealed class ColdStartCacheTests : IDisposable
{
    private readonly string root;
    private readonly string projectFilePath;
    private readonly string assemblyName = "Sample";

    public ColdStartCacheTests()
    {
        // Keep scratch dirs under the test output directory (never /tmp).
        root = Path.Combine(AppContext.BaseDirectory, "lscache-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        projectFilePath = Path.Combine(root, assemblyName + ".gsproj");
        File.WriteAllText(projectFilePath, "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>");
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
        catch (IOException)
        {
        }
    }

    private static ReferenceMetadataIndex SampleIndex()
    {
        var corePath = typeof(ReferenceResolver).Assembly.Location;
        using var resolver = ReferenceResolver.WithReferences(new[] { corePath });
        return resolver.ExportMetadataIndex();
    }

    private string DescriptorPath() => ColdStartCache.DescriptorPath(projectFilePath, assemblyName);

    private string MakeRefFile(string name, string content)
    {
        var path = Path.Combine(root, name);
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public void Save_Then_Load_RoundTrips_The_Index()
    {
        var refA = MakeRefFile("a.dll", "aaa");
        var refs = new[] { refA };
        var rsp = MakeRefFile("Sample.rsp", "/r:a.dll");
        var index = SampleIndex();

        ColdStartCache.Save(projectFilePath, assemblyName, refs, rsp, "srcfp", "net8.0", index);

        Assert.True(File.Exists(DescriptorPath()));

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rsp, "srcfp", "net8.0");
        Assert.NotNull(loaded);
        Assert.True(index.AssemblyIdentities.SequenceEqual(loaded.AssemblyIdentities));
        Assert.Equal(index.ToNameIndex().Count, loaded.ToNameIndex().Count);
    }

    [Fact]
    public void Only_One_Cache_File_Is_Written_No_Binary_Sibling()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        var produced = Directory.GetFiles(root, "*.lscache*");
        Assert.Single(produced);
        Assert.EndsWith(".gsproj.lscache", produced[0]);
        Assert.Empty(Directory.GetFiles(root, "*.lscache.bin"));
    }

    [Fact]
    public void Descriptor_Is_Human_Readable_With_Header_Comment_Committable_Note_And_OptOut()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        var text = File.ReadAllText(DescriptorPath());
        Assert.StartsWith("version=", text);
        Assert.Contains("#", text);
        Assert.Contains("[project]", text);
        Assert.Contains("[fingerprint]", text);
        Assert.Contains("[references]", text);
        Assert.Contains("[metadataIndex]", text);
        Assert.Contains("GSHARP_DISABLE_COLD_START_CACHE", text);
        Assert.Contains("commit", text); // committable opt-in note
        Assert.Contains("targetFramework=net8.0", text);
    }

    [Fact]
    public void Load_Returns_Null_When_References_Change()
    {
        var refA = MakeRefFile("a.dll", "aaa");
        ColdStartCache.Save(projectFilePath, assemblyName, new[] { refA }, rspPath: null, "srcfp", "net8.0", SampleIndex());

        var refB = MakeRefFile("b.dll", "bbb");
        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, new[] { refA, refB }, rspPath: null, "srcfp", "net8.0");
        Assert.Null(loaded);
    }

    [Fact]
    public void Load_Returns_Null_When_A_Reference_Is_Touched()
    {
        var refA = MakeRefFile("a.dll", "aaa");
        var refs = new[] { refA };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        System.Threading.Thread.Sleep(10);
        File.WriteAllText(refA, "aaaa-modified");
        File.SetLastWriteTimeUtc(refA, DateTime.UtcNow.AddSeconds(5));

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0");
        Assert.Null(loaded);
    }

    [Fact]
    public void Load_Returns_Null_When_Source_Fingerprint_Changes()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp-v1", "net8.0", SampleIndex());

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp-v2", "net8.0");
        Assert.Null(loaded);
    }

    [Fact]
    public void Load_Returns_Null_When_Target_Framework_Changes()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net9.0");
        Assert.Null(loaded);
    }

    [Fact]
    public void Load_Survives_An_Rsp_Rebuild_Because_The_Rsp_Is_Not_In_The_Fingerprint()
    {
        // The .rsp is an ephemeral obj/ artifact; a clean/clone removes it. The
        // fingerprint deliberately excludes it, so touching/rebuilding the .rsp
        // (without changing the resolved reference set) must NOT invalidate.
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        var rsp = MakeRefFile("Sample.rsp", "/r:a.dll");
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rsp, "srcfp", "net8.0", SampleIndex());

        System.Threading.Thread.Sleep(10);
        File.SetLastWriteTimeUtc(rsp, DateTime.UtcNow.AddSeconds(5));

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rsp, "srcfp", "net8.0");
        Assert.NotNull(loaded);

        // And it loads identically with no .rsp at all.
        var loadedNoRsp = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0");
        Assert.NotNull(loadedNoRsp);
    }

    [Fact]
    public void Load_Returns_Null_When_Index_Section_Is_Corrupt()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        // Flip a type-name in the [metadataIndex] section: it still parses
        // structurally, but the recorded index SHA-256 no longer matches.
        var path = DescriptorPath();
        var text = File.ReadAllText(path);
        var corrupted = text.Replace(
            "GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver",
            "GSharp.Core.CodeAnalysis.Symbols.ReferenceXesolver");
        Assert.NotEqual(text, corrupted);
        File.WriteAllText(path, corrupted);

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0");
        Assert.Null(loaded);
    }

    [Fact]
    public void Load_Returns_Null_When_File_Is_Missing()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        Assert.Null(ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0"));
    }

    [Fact]
    public void Deleting_Cache_File_Is_Safe()
    {
        var refs = new[] { MakeRefFile("a.dll", "aaa") };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        File.Delete(DescriptorPath());

        Assert.Null(ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0"));
        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName));
    }

    [Fact]
    public void OptOut_Writes_Nothing_And_Loads_Nothing()
    {
        const string varName = "GSHARP_DISABLE_COLD_START_CACHE";
        var previous = Environment.GetEnvironmentVariable(varName);
        try
        {
            Environment.SetEnvironmentVariable(varName, "1");
            Assert.True(ColdStartCache.Disabled);

            var refs = new[] { MakeRefFile("a.dll", "aaa") };
            ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

            Assert.False(File.Exists(DescriptorPath()));
            Assert.Null(ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0"));
            Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName));
        }
        finally
        {
            Environment.SetEnvironmentVariable(varName, previous);
        }
    }

    [Fact]
    public void Loaded_Index_Is_Adoptable_By_A_Fresh_Resolver()
    {
        var corePath = typeof(ReferenceResolver).Assembly.Location;
        var refs = new[] { corePath };
        using (var producer = ReferenceResolver.WithReferences(refs))
        {
            ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", producer.ExportMetadataIndex());
        }

        var loaded = ColdStartCache.TryLoad(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0");
        Assert.NotNull(loaded);

        using var consumer = ReferenceResolver.WithReferences(refs);
        Assert.True(consumer.TryUseMetadataIndex(loaded));
        Assert.True(consumer.TryResolveType("System.String", out var stringType));
        Assert.Equal("System.String", stringType.FullName);
    }

    [Fact]
    public void TryBootstrapReferences_Returns_Validated_Set()
    {
        var refA = MakeRefFile("a.dll", "aaa");
        var refB = MakeRefFile("b.dll", "bbbb");
        var refs = new[] { refA, refB };
        ColdStartCache.Save(projectFilePath, assemblyName, refs, rspPath: null, "srcfp", "net8.0", SampleIndex());

        var bootstrapped = ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName);
        Assert.NotNull(bootstrapped);
        Assert.Equal(new[] { refA, refB }, bootstrapped);
    }

    [Fact]
    public void TryBootstrapReferences_Returns_Null_When_A_Reference_Is_Missing()
    {
        var refA = MakeRefFile("a.dll", "aaa");
        ColdStartCache.Save(projectFilePath, assemblyName, new[] { refA }, rspPath: null, "srcfp", "net8.0", SampleIndex());

        File.Delete(refA);

        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName));
    }

    [Fact]
    public void TryBootstrapReferences_Returns_Null_When_A_Reference_Changed()
    {
        var refA = MakeRefFile("a.dll", "aaa");
        ColdStartCache.Save(projectFilePath, assemblyName, new[] { refA }, rspPath: null, "srcfp", "net8.0", SampleIndex());

        System.Threading.Thread.Sleep(10);
        File.WriteAllText(refA, "changed-content");
        File.SetLastWriteTimeUtc(refA, DateTime.UtcNow.AddSeconds(5));

        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName));
    }

    [Fact]
    public void ProjectState_WarmFromCache_Produces_Diagnostics_Identical_To_Cold()
    {
        const string source = "import System\nfunc main() {\nConsole.WriteLine(\"hi\")\n}\n";
        var corePath = typeof(ReferenceResolver).Assembly.Location;
        var sourcePath = Path.Combine(root, "Program.gs");
        File.WriteAllText(sourcePath, source);

        // Cold run: no cache present yet -> a from-scratch build that also writes
        // the cache. This is the correctness oracle.
        var coldDiagnostics = AnalyzeDiagnostics(new[] { corePath }, rspPath: null, sourcePath);

        // The cache must now exist on disk.
        Assert.True(File.Exists(DescriptorPath()));

        // Warm run: a fresh ProjectState over the same inputs loads the cache.
        var warmDiagnostics = AnalyzeDiagnostics(new[] { corePath }, rspPath: null, sourcePath);

        Assert.Equal(coldDiagnostics, warmDiagnostics);
    }

    [Fact]
    public void ProjectState_BootstrapsReferences_From_Cache_When_Rsp_Absent()
    {
        const string source = "import System\nfunc main() {\nConsole.WriteLine(\"hi\")\n}\n";
        var corePath = typeof(ReferenceResolver).Assembly.Location;
        var sourcePath = Path.Combine(root, "Program.gs");
        File.WriteAllText(sourcePath, source);

        // 1) A normal .rsp-backed build resolves references and writes the cache.
        var rspBackedDiagnostics = AnalyzeDiagnostics(new[] { corePath }, rspPath: null, sourcePath);
        Assert.True(File.Exists(DescriptorPath()));

        // 2) Simulate `dotnet clean` / a fresh clone: the .rsp is gone and the LSP
        //    discovers EMPTY references. With the committed/retained .lscache, the
        //    project bootstraps its reference set from the cache and resolves the
        //    imported types -> diagnostics identical to the .rsp-backed build.
        //    (Proven directly: the cache supplies the reference set.)
        var bootstrapped = ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName);
        Assert.NotNull(bootstrapped);
        Assert.Contains(corePath, bootstrapped);

        var bootstrapDiagnostics = AnalyzeDiagnostics(Array.Empty<string>(), rspPath: null, sourcePath);
        Assert.Equal(rspBackedDiagnostics, bootstrapDiagnostics);

        // 3) Safe fallback: if a referenced DLL is missing/changed (or the cache is
        //    gone), the bootstrap refuses to supply a stale reference set and the
        //    LSP degrades to today's empty-reference behavior rather than resolving
        //    against the wrong DLLs.
        File.Delete(DescriptorPath());
        Assert.Null(ColdStartCache.TryBootstrapReferences(projectFilePath, assemblyName));
    }

    private List<string> AnalyzeDiagnostics(IReadOnlyList<string> references, string rspPath, string sourcePath)
    {
        var project = new ProjectState(projectFilePath)
        {
            AssemblyName = assemblyName,
            ReferenceSourcePath = rspPath,
            References = references,
        };
        project.AddFileFromDisk(sourcePath);

        var compilation = project.GetCompilation();
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Select(d => d.ToString())
            .OrderBy(s => s, StringComparer.Ordinal)
            .ToList();
    }
}
