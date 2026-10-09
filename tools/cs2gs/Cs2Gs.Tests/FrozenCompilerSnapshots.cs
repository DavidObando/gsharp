// <copyright file="FrozenCompilerSnapshots.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4661: C# inputs of cs2gs regression tests that used to be read from
/// the compiler's own committed sources. After the G# cut-over those sources
/// are <c>.gs</c>, so each such input is pinned as a checked-in
/// <c>Fixtures/FrozenCompiler/*.cs.txt</c> snapshot. While the live file is
/// still C# the snapshot is compared against it (see
/// <see cref="FindDrift"/>), so a snapshot cannot silently go stale; once the
/// live file is gone the snapshot is the frozen input.
/// </summary>
internal static class FrozenCompilerSnapshots
{
    /// <summary>Starts the part of a snapshot that must match the live file.</summary>
    internal const string RegionBegin = "// frozen-region-begin";

    /// <summary>Ends the part of a snapshot that must match the live file.</summary>
    internal const string RegionEnd = "// frozen-region-end";

    private const string AnalyzersDirectory = "InternalAnalyzers/";

    /// <summary>
    /// Every snapshot and the repository-relative C# file it mirrors. A snapshot
    /// with region markers is mirrored by the text between them (contained in
    /// the live file); one without is mirrored by the whole live file.
    /// </summary>
    internal static readonly IReadOnlyList<(string Snapshot, string Live)> Manifest = new (string, string)[]
    {
        (AnalyzersDirectory + "BaseClassCycleUnsafeWalkAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/BaseClassCycleUnsafeWalkAnalyzer.cs"),
        (AnalyzersDirectory + "DiagnosticDescriptors.cs.txt", "src/Analyzers/InternalAnalyzers/DiagnosticDescriptors.cs"),
        (AnalyzersDirectory + "EmitCacheKeyRemapScopeAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/EmitCacheKeyRemapScopeAnalyzer.cs"),
        (AnalyzersDirectory + "ReflectionTypeComparisonAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/ReflectionTypeComparisonAnalyzer.cs"),
        (AnalyzersDirectory + "RewriterClonePreservationAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/RewriterClonePreservationAnalyzer.cs"),
        (AnalyzersDirectory + "StrongStaticReflectionCacheAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/StrongStaticReflectionCacheAnalyzer.cs"),
        (AnalyzersDirectory + "StructFieldDefsReadAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/StructFieldDefsReadAnalyzer.cs"),
        ("Issue3461ContextualStatics.cs.txt", "tools/cs2gs/Cs2Gs.Tests/Issue3461IdentifierSanitizationTests.cs"),
        ("Issue3466LateSignatureTypes.cs.txt", "tools/cs2gs/Cs2Gs.Tests/Issue3466LateSignatureTypes.cs"),
        ("ManagedReferenceArrayNullableState.cs.txt", "tools/cs2gs/Cs2Gs.Translator/ManagedReferenceArrayNullableState.cs"),
    };

    /// <summary>The snapshot text of one analyzer source under <c>src/Analyzers/InternalAnalyzers</c>.</summary>
    /// <param name="fileName">The analyzer file name, e.g. <c>StructFieldDefsReadAnalyzer.cs</c>.</param>
    /// <returns>The pinned C# source.</returns>
    internal static string Analyzer(string fileName) => Read(AnalyzersDirectory + fileName + ".txt");

    /// <summary>Reads a snapshot; an empty snapshot is an error, not an empty input.</summary>
    /// <param name="relativePath">The path under <c>Fixtures/FrozenCompiler</c>.</param>
    /// <returns>The snapshot text.</returns>
    internal static string Read(string relativePath)
    {
        string path = Path(relativePath);
        string text = File.ReadAllText(path);
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new InvalidOperationException($"Frozen compiler snapshot '{relativePath}' is empty.");
        }

        return text;
    }

    /// <summary>The absolute path of a snapshot.</summary>
    /// <param name="relativePath">The path under <c>Fixtures/FrozenCompiler</c>.</param>
    /// <returns>The path.</returns>
    internal static string Path(string relativePath) =>
        TestFixtureSource.Resolve(
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Fixtures",
            "FrozenCompiler",
            relativePath.Replace('/', System.IO.Path.DirectorySeparatorChar));

    /// <summary>
    /// Compares a snapshot with the live file it mirrors.
    /// </summary>
    /// <param name="snapshot">The snapshot text.</param>
    /// <param name="live">The live C# text.</param>
    /// <returns>A description of the drift, or <see langword="null"/> when the snapshot is honest.</returns>
    internal static string FindDrift(string snapshot, string live)
    {
        string normalizedLive = Normalize(live);
        int begin = snapshot.IndexOf(RegionBegin, StringComparison.Ordinal);
        int end = snapshot.IndexOf(RegionEnd, StringComparison.Ordinal);
        if (begin < 0 && end < 0)
        {
            return string.Equals(Normalize(snapshot), normalizedLive, StringComparison.Ordinal)
                ? null
                : "the snapshot differs from the whole live file";
        }

        if (begin < 0 || end < begin)
        {
            throw new InvalidOperationException(
                $"A snapshot region needs '{RegionBegin}' followed by '{RegionEnd}'.");
        }

        string region = Normalize(snapshot.Substring(begin + RegionBegin.Length, end - begin - RegionBegin.Length));
        if (region.Trim().Length == 0)
        {
            throw new InvalidOperationException("A snapshot region must not be empty.");
        }

        return normalizedLive.Contains(region, StringComparison.Ordinal)
            ? null
            : "the snapshot region is not contained in the live file";
    }

    private static string Normalize(string text)
    {
        var builder = new StringBuilder();
        foreach (string line in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            builder.Append(line.TrimEnd()).Append('\n');
        }

        return builder.ToString().Trim('\n') + "\n";
    }
}
