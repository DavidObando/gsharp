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
using System.Text;
using System.Text.Json;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
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
/// change, run the manual <see cref="RegenerateBaseline"/> entry point in
/// this file (see <c>test/Core.Tests/Baselines/README.md</c>).
/// </summary>
public class RefactoringBaselineTests
{
    private const string BaselineFileName = "refactoring-baseline.json";

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
    };

    public static IEnumerable<object[]> Samples()
    {
        var repoRoot = LocateRepoRoot();
        if (repoRoot is null)
        {
            yield break;
        }

        foreach (var rel in EnumerateSampleRelativePaths(repoRoot))
        {
            yield return new object[] { rel };
        }
    }

    [Theory]
    [MemberData(nameof(Samples))]
    public void Sample_EmittedPE_Matches_Baseline(string relativeSamplePath)
    {
        var repoRoot = LocateRepoRoot();
        Assert.NotNull(repoRoot);

        var baseline = LoadBaseline(repoRoot!);
        Assert.True(
            baseline.TryGetValue(relativeSamplePath, out var expectedHash),
            $"No baseline entry for '{relativeSamplePath}'. Regenerate via the RegenerateBaseline manual fact (see test/Core.Tests/Baselines/README.md) and commit the diff.");

        if (expectedHash is null)
        {
            // Deliberately skipped (documented in samples/refactoring-baseline/README.md).
            return;
        }

        var absoluteSamplePath = Path.Combine(repoRoot!, relativeSamplePath);
        var (success, actualHash, diagnostics) = TryHashSample(absoluteSamplePath);

        Assert.True(
            success,
            $"Sample '{relativeSamplePath}' failed to compile but the baseline expected it to succeed. Diagnostics: {diagnostics}");

        Assert.True(
            string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase),
            $"IL byte-identical gate FAILED for '{relativeSamplePath}'.\n" +
            $"  expected: {expectedHash}\n" +
            $"  actual:   {actualHash}\n" +
            "If this PR intentionally changed emitted IL, regenerate the baseline (see test/Core.Tests/Baselines/README.md). Otherwise, an extraction has silently changed IL — investigate the divergence.");
    }

    /// <summary>
    /// Manual entry point: un-skip locally, run, then commit the regenerated
    /// <c>refactoring-baseline.json</c>. See
    /// <c>test/Core.Tests/Baselines/README.md</c> for the procedure.
    /// </summary>
    [Fact(Skip = "manual: un-skip to regenerate test/Core.Tests/Baselines/refactoring-baseline.json")]
    public void RegenerateBaseline()
    {
        var repoRoot = LocateRepoRoot();
        Assert.NotNull(repoRoot);

        var entries = new SortedDictionary<string, string?>(StringComparer.Ordinal);
        var skipped = new List<string>();

        foreach (var rel in EnumerateSampleRelativePaths(repoRoot!))
        {
            if (KnownCompileFailureSamples.Contains(rel))
            {
                entries[rel] = null;
                continue;
            }

            var absolute = Path.Combine(repoRoot!, rel);
            var (success, hash, diagnostics) = TryHashSample(absolute);
            if (success)
            {
                entries[rel] = hash;
            }
            else
            {
                entries[rel] = null;
                skipped.Add($"{rel}: {diagnostics}");
            }
        }

        WriteBaseline(repoRoot!, entries);

        if (skipped.Count > 0)
        {
            // Surface skips so the regenerator updates samples/refactoring-baseline/README.md.
            throw new InvalidOperationException(
                "Baseline regenerated, but some samples failed to compile and were recorded with a null hash. Document each in samples/refactoring-baseline/README.md:\n" +
                string.Join("\n", skipped));
        }
    }

    private static (bool Success, string Hash, string Diagnostics) TryHashSample(string absoluteSamplePath)
    {
        var source = File.ReadAllText(absoluteSamplePath);
        var fileName = Path.GetFileName(absoluteSamplePath);
        var tree = SyntaxTree.Parse(SourceText.From(source, fileName));

        var compilation = new Compilation(tree)
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
            return (false, string.Empty, diagnostics);
        }

        var bytes = peStream.ToArray();
        var hash = HashEmittedContent(bytes);
        return (true, hash, string.Empty);
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

    private static SortedDictionary<string, string?> LoadBaseline(string repoRoot)
    {
        var path = Path.Combine(repoRoot, "test", "Core.Tests", "Baselines", BaselineFileName);
        if (!File.Exists(path))
        {
            throw new FileNotFoundException(
                $"Baseline file '{path}' does not exist. Regenerate via the RegenerateBaseline manual fact (see test/Core.Tests/Baselines/README.md).");
        }

        using var stream = File.OpenRead(path);
        var parsed = JsonSerializer.Deserialize<Dictionary<string, string?>>(stream) ?? new();
        return new SortedDictionary<string, string?>(parsed, StringComparer.Ordinal);
    }

    private static void WriteBaseline(string repoRoot, SortedDictionary<string, string?> entries)
    {
        var dir = Path.Combine(repoRoot, "test", "Core.Tests", "Baselines");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, BaselineFileName);

        var options = new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        var json = JsonSerializer.Serialize(entries, options);
        File.WriteAllText(path, json + Environment.NewLine, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
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
