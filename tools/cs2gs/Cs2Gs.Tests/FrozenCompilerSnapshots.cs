// <copyright file="FrozenCompilerSnapshots.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4661: C# inputs of cs2gs regression tests that used to be read from
/// the compiler's own committed sources. After the G# cut-over those sources
/// are <c>.gs</c>, so each such input is pinned as a checked-in
/// <c>Fixtures/FrozenCompiler/*.cs.txt</c> snapshot. While the live file is
/// still C# the snapshot is compared against it (see
/// <see cref="LiveText"/>), so a snapshot cannot silently go stale; once the
/// live file is gone the snapshot is the frozen input.
/// </summary>
internal static class FrozenCompilerSnapshots
{
    private const string AnalyzersDirectory = "InternalAnalyzers/";

    /// <summary>
    /// Every snapshot and the repository-relative C# file it mirrors. A snapshot
    /// flagged Region mirrors the tail of the live file from the snapshot's
    /// first line; any other snapshot mirrors the whole live file.
    /// </summary>
    internal static readonly IReadOnlyList<(string Snapshot, string Live, bool Region)> Manifest = new (string, string, bool)[]
    {
        (AnalyzersDirectory + "BaseClassCycleUnsafeWalkAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/BaseClassCycleUnsafeWalkAnalyzer.cs", false),
        (AnalyzersDirectory + "DiagnosticDescriptors.cs.txt", "src/Analyzers/InternalAnalyzers/DiagnosticDescriptors.cs", false),
        (AnalyzersDirectory + "EmitCacheKeyRemapScopeAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/EmitCacheKeyRemapScopeAnalyzer.cs", false),
        (AnalyzersDirectory + "ReflectionTypeComparisonAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/ReflectionTypeComparisonAnalyzer.cs", false),
        (AnalyzersDirectory + "RewriterClonePreservationAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/RewriterClonePreservationAnalyzer.cs", false),
        (AnalyzersDirectory + "StrongStaticReflectionCacheAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/StrongStaticReflectionCacheAnalyzer.cs", false),
        (AnalyzersDirectory + "StructFieldDefsReadAnalyzer.cs.txt", "src/Analyzers/InternalAnalyzers/StructFieldDefsReadAnalyzer.cs", false),
        ("DocumentTranslationState.cs.txt", "tools/cs2gs/Cs2Gs.Translator/DocumentTranslationState.cs", false),
        ("Issue3461ContextualStatics.cs.txt", "tools/cs2gs/Cs2Gs.Tests/Issue3461IdentifierSanitizationTests.cs", true),
        ("Issue3466LateSignatureTypes.cs.txt", "tools/cs2gs/Cs2Gs.Tests/Issue3466LateSignatureTypes.cs", false),
        ("ManagedReferenceArrayNullableState.cs.txt", "tools/cs2gs/Cs2Gs.Translator/ManagedReferenceArrayNullableState.cs", false),
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
    /// The live text a snapshot is compared with: the whole live file, or for a
    /// region snapshot the tail of the live file that starts at the
    /// snapshot's first line (up to the end of the file, so the end does not
    /// depend on the snapshot's current length and a refresh stays complete). A region whose
    /// first line is not found throws, so a refresh can never write an empty
    /// snapshot.
    /// </summary>
    /// <param name="snapshot">The snapshot text.</param>
    /// <param name="live">The live C# text.</param>
    /// <param name="region">Whether the snapshot mirrors only a region of the live file.</param>
    /// <returns>The live text to compare.</returns>
    internal static string LiveText(string snapshot, string live, bool region)
    {
        string normalizedLive = Normalize(live);
        if (!region)
        {
            return normalizedLive;
        }

        string[] snapshotLines = Normalize(snapshot).TrimEnd('\n').Split('\n');
        string[] liveLines = normalizedLive.TrimEnd('\n').Split('\n');
        int start = Array.IndexOf(liveLines, snapshotLines[0]);
        if (start < 0)
        {
            throw new InvalidOperationException(
                $"The first line of the region snapshot is not in the live file: '{snapshotLines[0]}'. Re-point the snapshot at the moved or edited region by hand.");
        }

        return string.Join("\n", liveLines, start, liveLines.Length - start) + "\n";
    }

    private static string Normalize(string text) =>
        text.ReplaceLineEndings("\n");
}
