// <copyright file="RefactoringBaselineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.Json;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// IL byte-identical gate (PR-0 of the Binder/Emitter decomposition).
///
/// For every <c>.gs</c> source in <c>samples/</c> and
/// <c>samples/refactoring-baseline/</c>, this test compiles the source with
/// deterministic emit enabled, hashes the metadata stream (with the MVID
/// GUID bytes zeroed) plus every method body's IL bytes, and compares the
/// hex SHA-256 digest against the value committed in
/// <c>test/Core.Tests/Baselines/refactoring-baseline.json</c>.
///
/// Any "behavior-preserving" extraction PR that quietly changes emitted IL
/// will fail this gate. The fix is to find the divergence in the extraction,
/// not to regenerate the baseline. To regenerate after an intentional IL
/// change, run this test with <c>GSHARP_UPDATE_GOLDENS=1</c> (see
/// <c>test/Core.Tests/Baselines/README.md</c>).
/// </summary>
public class RefactoringBaselineTests
{
    private const string BaselineFileName = "refactoring-baseline.json";

    private const string TablesFileName = "refactoring-baseline-tables.json";

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Samples that currently fail to compile on main. Recorded with a
    /// <c>null</c> baseline; documented in
    /// <c>samples/refactoring-baseline/README.md</c>.
    /// </summary>
    private static readonly HashSet<string> KnownCompileFailureSamples = new(StringComparer.Ordinal)
    {
        "samples/refactoring-baseline/ClosureCaptureRefTypeField.gs",

        // Samples that import Gsharp.Extensions.* — they require
        // `/r:Gsharp.Extensions.dll` to bind, which the
        // RefactoringBaseline compile path (a plain Compilation with no
        // extra references) does not supply. They are exercised
        // end-to-end by Compiler.Tests.SampleConformanceTests where the
        // assembly is staged correctly.
        "samples/GsharpExtensionsMixed.gs",
        "samples/GsharpExtensionsOptional.gs",
        "samples/GsharpExtensionsSequences.gs",

        // ADR-0174 D9: `after` and `tick` are G#-authored helpers in
        // Gsharp.Extensions, so this sample needs the same `/r:` the three
        // above do. SampleConformanceTests stages it correctly.
        "samples/Timeout.gs",
    };

    [Fact]
    public void Samples_EmittedPE_Match_Baseline()
    {
        string repoRoot = LocateRepoRoot()
            ?? throw new InvalidOperationException("Could not locate repository root.");

        var entries = new SortedDictionary<string, string?>(StringComparer.Ordinal);
        var tables = new SortedDictionary<string, SortedDictionary<string, string[]>>(StringComparer.Ordinal);
        var failures = new List<string>();

        // One resolver for the whole loop: building the ref-pack metadata context per sample is pure overhead.
        using var references = SampleReferences.CreateResolver();

        foreach (var rel in EnumerateSampleRelativePaths(repoRoot))
        {
            if (KnownCompileFailureSamples.Contains(rel))
            {
                entries[rel] = null;
                continue;
            }

            var absolute = Path.Combine(repoRoot, rel);
            var (success, hash, diagnostics, sampleTables) = TryHashSample(absolute, references);
            if (success)
            {
                entries[rel] = hash;
                tables[rel] = sampleTables ?? throw new InvalidOperationException("no table digest for a compiled sample");
            }
            else
            {
                failures.Add($"{rel}: {diagnostics}");
            }
        }

        Assert.True(
            failures.Count == 0,
            "Samples expected to compile failed before the IL baseline could be compared:\n"
            + string.Join("\n", failures));

        string baselinePath = Path.Combine(
            repoRoot,
            "test",
            "Core.Tests",
            "Baselines",
            BaselineFileName);
        string tablesPath = Path.Combine(Path.GetDirectoryName(baselinePath) ?? throw new InvalidOperationException("The baseline path has no directory."), TablesFileName);
        try
        {
            GoldenFile.AssertMatches(
                baselinePath,
                SerializeBaseline(entries),
                "IL byte-identical gate failed. Investigate unintended emit drift; "
                + "accept and commit a regenerated baseline only for an intentional IL change.");
        }
        catch (GoldenFileException ex)
        {
            // Issue #4665: say which metadata tables moved, as a triage aid. The
            // pattern only suggests a cause; the rows still need inspecting.
            throw new GoldenFileException(
                ex.Message + "\n" + DescribeTableDrift(tablesPath, tables, entries, baselinePath));
        }

        // The table digests accompany the hashes: written together under
        // GSHARP_UPDATE_GOLDENS, and a mismatch here means the digests were not
        // regenerated with the baseline.
        GoldenFile.AssertMatches(
            tablesPath,
            JsonSerializer.Serialize(tables, SerializerOptions) + "\n",
            "The per-table digests behind the IL baseline are stale; regenerate them with the baseline.");
    }

    /// <summary>
    /// Pins the triage output: the table diff names exactly the tables that moved.
    /// It reports which tables changed; it does not decide whether the cause is
    /// the reference set or codegen.
    /// </summary>
    [Fact]
    public void MetadataTableDiff_NamesTheTablesThatMoved()
    {
        var baseline = new SortedDictionary<string, string[]>
        {
            [MetadataTableDigest.AssemblyRef] = new[] { "System.Private.CoreLib, 10.0.0.0, 7CEC85D7BEA7798E" },
            ["TypeRef"] = new[] { "rows=3 sha256=AA" },
            [MetadataTableDigest.MethodBodies] = new[] { "rows=2 sha256=BB" },
        };
        var referenceTablesMoved = new SortedDictionary<string, string[]>(baseline)
        {
            [MetadataTableDigest.AssemblyRef] = new[] { "System.Runtime, 10.0.0.0, B03F5F7F11D50A3A" },
            ["TypeRef"] = new[] { "rows=3 sha256=CC" },
        };
        var bodiesMoved = new SortedDictionary<string, string[]>(baseline)
        {
            [MetadataTableDigest.MethodBodies] = new[] { "rows=2 sha256=DD" },
        };

        Assert.Equal(
            new[] { "AssemblyRef", "TypeRef" },
            MetadataTableDigest.Diff(baseline, referenceTablesMoved).Select(l => l.Split(':')[0]));
        Assert.Equal(
            new[] { "MethodBodies" },
            MetadataTableDigest.Diff(baseline, bodiesMoved).Select(l => l.Split(':')[0]));
        Assert.Empty(MetadataTableDigest.Diff(baseline, new SortedDictionary<string, string[]>(baseline)));
    }

    /// <summary>
    /// The sample compilations must not see which assemblies the test host
    /// loaded: the resolver has to be the ref pack plus the bundled G# runtime,
    /// with none of the host's test-only assemblies in it.
    /// </summary>
    [Fact]
    public void SampleResolver_DoesNotContainHostLoadedAssemblies()
    {
        const string HostOnly = "GSharp.Core.Tests";

        // Control: the default resolver is built from the host's loaded assemblies.
        Assert.Contains(
            GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.Default().Assemblies,
            a => a.GetName().Name == HostOnly);

        using var resolver = SampleReferences.CreateResolver();
        var names = resolver.Assemblies.Select(a => a.GetName().Name).ToList();
        Assert.DoesNotContain(HostOnly, names);
        Assert.Contains("System.Runtime", names);
    }

    private static string DescribeTableDrift(
        string tablesPath,
        SortedDictionary<string, SortedDictionary<string, string[]>> actual,
        SortedDictionary<string, string?> entries,
        string baselinePath)
    {
        if (!File.Exists(tablesPath) || !File.Exists(baselinePath))
        {
            return "No committed table digests to diff against.";
        }

        var expectedTables = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string[]>>>(
            File.ReadAllText(tablesPath)) ?? new();
        var expectedHashes = JsonSerializer.Deserialize<Dictionary<string, string?>>(File.ReadAllText(baselinePath))
            ?? new();
        var report = new System.Text.StringBuilder("Metadata tables that moved, per sample (a change confined to "
            + "AssemblyRef/TypeRef/MemberRef with unchanged MethodBodies is LIKELY a reference-set difference; inspect the rows, since a metadata-only emitter change can also retarget them):\n");
        int reported = 0;
        foreach (var (rel, hash) in entries)
        {
            if (hash is null || (expectedHashes.TryGetValue(rel, out var old) && string.Equals(old, hash, StringComparison.Ordinal)))
            {
                continue;
            }

            if (!expectedTables.TryGetValue(rel, out var oldTables))
            {
                report.Append("  ").Append(rel).Append(": no committed digest\n");
            }
            else
            {
                var moved = MetadataTableDigest.Diff(oldTables, actual[rel]);
                foreach (string line in moved)
                {
                    report.Append("  ").Append(rel).Append(" ").Append(line).Append('\n');
                }

                if (moved.Count == 0)
                {
                    // Fail-safe: the hash moved but no tracked table did, so the
                    // digest is missing a column. Say so rather than print nothing.
                    report.Append("  ").Append(rel).Append(": hash changed but no tracked table moved (digest gap)\n");
                }
            }

            if (++reported >= 10)
            {
                report.Append("  ... (further samples elided; fix the ones above and rerun for the rest)\n");
                break;
            }
        }

        return report.ToString();
    }

    private static (bool Success, string Hash, string Diagnostics, SortedDictionary<string, string[]>? Tables) TryHashSample(string absoluteSamplePath, GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver references)
    {
        var source = File.ReadAllText(absoluteSamplePath);
        var fileName = Path.GetFileName(absoluteSamplePath);
        var tree = SyntaxTree.Parse(SourceText.From(source, fileName));

        // Issue #4665: an explicit reference set, never ReferenceResolver.Default().
        var compilation = new Compilation(references, tree)
        {
            DebugInformation = new DebugInformationOptions { Deterministic = true },
        };

        using var peStream = new MemoryStream();
        var result = compilation.Emit(
            peStream: peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "GSharp.RefactoringBaseline",
            assemblyVersion: "1.0.0.0");

        if (!result.Success)
        {
            var diagnostics = string.Join("; ", result.Diagnostics.Select(d => d.Message));
            return (false, string.Empty, diagnostics, null);
        }

        var bytes = peStream.ToArray();
        var hash = HashEmittedContent(bytes);
        return (true, hash, string.Empty, MetadataTableDigest.Compute(bytes));
    }

    /// <summary>
    /// Hash the parts of the PE that the gate is supposed to pin: the
    /// metadata stream (modulo the MVID GUID, which is a content-derived
    /// nondeterministic id) and every method body's IL bytes (in MethodDef
    /// order). Deliberately excludes the PE wrapper — headers, section
    /// layout, debug directory, PE checksum, COFF TimeDateStamp — because
    /// those are determined by deterministic content hashes of the IL +
    /// metadata themselves and any drift in them is downstream of, not a
    /// substitute for, "did the emitted code change?"
    /// </summary>
    private static string HashEmittedContent(byte[] bytes)
    {
        using var pe = new PEReader(new MemoryStream(bytes, writable: false));
        var mdReader = pe.GetMetadataReader();

        using var sha = SHA256.Create();
        sha.Initialize();

        var mdStart = pe.PEHeaders.MetadataStartOffset;
        var mdSize = pe.PEHeaders.MetadataSize;

        // 1. Hash the metadata stream verbatim, but with the MVID GUID
        // overwritten with zero bytes. We locate the MVID by reading its
        // value out of the module-def row and then masking every occurrence
        // inside the metadata stream (the #GUID heap stores it once; the
        // search loop also catches any place a future emitter might
        // embed it again).
        var mdCopy = new byte[mdSize];
        Array.Copy(bytes, mdStart, mdCopy, 0, mdSize);

        var mvid = mdReader.GetGuid(mdReader.GetModuleDefinition().Mvid);
        if (mvid != Guid.Empty)
        {
            var mvidBytes = mvid.ToByteArray();
            int searchStart = 0;
            while (true)
            {
                int idx = IndexOf(mdCopy, mvidBytes, searchStart);
                if (idx < 0)
                {
                    break;
                }

                for (int i = 0; i < mvidBytes.Length; i++)
                {
                    mdCopy[idx + i] = 0;
                }

                searchStart = idx + mvidBytes.Length;
            }
        }

        sha.TransformBlock(mdCopy, 0, mdCopy.Length, null, 0);

        // 2. Hash every method body's IL bytes in MethodDef table order.
        // PEReader.GetMethodBody handles the tiny vs fat header decode and
        // gives us a stable view of the IL stream.
        foreach (var methodHandle in mdReader.MethodDefinitions)
        {
            var method = mdReader.GetMethodDefinition(methodHandle);
            var rva = method.RelativeVirtualAddress;
            if (rva == 0)
            {
                continue;
            }

            var body = pe.GetMethodBody(rva);
            var il = body.GetILBytes();
            if (il is { Length: > 0 })
            {
                sha.TransformBlock(il, 0, il.Length, null, 0);
            }
        }

        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash!);
    }

    private static int IndexOf(byte[] haystack, byte[] needle, int start)
    {
        int last = haystack.Length - needle.Length;
        for (int i = start; i <= last; i++)
        {
            bool match = true;
            for (int j = 0; j < needle.Length; j++)
            {
                if (haystack[i + j] != needle[j])
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return i;
            }
        }

        return -1;
    }

    private static IEnumerable<string> EnumerateSampleRelativePaths(string repoRoot)
    {
        var topLevel = Path.Combine(repoRoot, "samples");
        if (Directory.Exists(topLevel))
        {
            foreach (var file in Directory.EnumerateFiles(topLevel, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(p => p, StringComparer.Ordinal))
            {
                yield return ToForwardSlashRelative(repoRoot, file);
            }
        }

        var curated = Path.Combine(repoRoot, "samples", "refactoring-baseline");
        if (Directory.Exists(curated))
        {
            foreach (var file in Directory.EnumerateFiles(curated, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(p => p, StringComparer.Ordinal))
            {
                yield return ToForwardSlashRelative(repoRoot, file);
            }
        }
    }

    private static string ToForwardSlashRelative(string repoRoot, string absolutePath)
    {
        var rel = Path.GetRelativePath(repoRoot, absolutePath);
        return rel.Replace(Path.DirectorySeparatorChar, '/');
    }

    private static string SerializeBaseline(SortedDictionary<string, string?> entries)
    {
        var options = new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        return JsonSerializer.Serialize(entries, options) + "\n";
    }

    private static string? LocateRepoRoot()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(RefactoringBaselineTests).Assembly.Location)!);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
