// <copyright file="FrozenCompilerSnapshots.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO

/// Issue #4661: C# inputs of cs2gs regression tests that used to be read from
/// the compiler's own committed sources. After the G# cut-over those sources
/// are `.gs`, so each such input is pinned as a checked-in
/// `Fixtures/FrozenCompiler/*.cs.txt` snapshot. While the live file is
/// still C# the snapshot is compared against it (see
/// (cref:LiveText)), so a snapshot cannot silently go stale; once the
/// live file is gone the snapshot is the frozen input.
internal shared class FrozenCompilerSnapshots {
    private const AnalyzersDirectory string = "InternalAnalyzers/"

    /// Every snapshot and the repository-relative C# file it mirrors. A snapshot
    /// flagged Region mirrors the tail of the live file from the snapshot's
    /// first line; any other snapshot mirrors the whole live file.
    internal let Manifest IReadOnlyList[(Snapshot string, Live string, Region bool)] = [](string, string, bool){
        (
            AnalyzersDirectory + "BaseClassCycleUnsafeWalkAnalyzer.cs.txt",
            "src/Analyzers/InternalAnalyzers/BaseClassCycleUnsafeWalkAnalyzer.cs",
            false
        ),
        (
            AnalyzersDirectory + "DiagnosticDescriptors.cs.txt",
            "src/Analyzers/InternalAnalyzers/DiagnosticDescriptors.cs",
            false
        ),
        (
            AnalyzersDirectory + "EmitCacheKeyRemapScopeAnalyzer.cs.txt",
            "src/Analyzers/InternalAnalyzers/EmitCacheKeyRemapScopeAnalyzer.cs",
            false
        ),
        (
            AnalyzersDirectory + "ReflectionTypeComparisonAnalyzer.cs.txt",
            "src/Analyzers/InternalAnalyzers/ReflectionTypeComparisonAnalyzer.cs",
            false
        ),
        (
            AnalyzersDirectory + "RewriterClonePreservationAnalyzer.cs.txt",
            "src/Analyzers/InternalAnalyzers/RewriterClonePreservationAnalyzer.cs",
            false
        ),
        (
            AnalyzersDirectory + "StrongStaticReflectionCacheAnalyzer.cs.txt",
            "src/Analyzers/InternalAnalyzers/StrongStaticReflectionCacheAnalyzer.cs",
            false
        ),
        (
            AnalyzersDirectory + "StructFieldDefsReadAnalyzer.cs.txt",
            "src/Analyzers/InternalAnalyzers/StructFieldDefsReadAnalyzer.cs",
            false
        ),
        ("DocumentTranslationState.cs.txt", "tools/cs2gs/Cs2Gs.Translator/DocumentTranslationState.cs", false),
        ("Issue3461ContextualStatics.cs.txt", "tools/cs2gs/Cs2Gs.Tests/Issue3461IdentifierSanitizationTests.cs", true),
        ("Issue3466LateSignatureTypes.cs.txt", "tools/cs2gs/Cs2Gs.Tests/Issue3466LateSignatureTypes.cs", false),
        (
            "ManagedReferenceArrayNullableState.cs.txt",
            "tools/cs2gs/Cs2Gs.Translator/ManagedReferenceArrayNullableState.cs",
            false
        )
    }

    /// The snapshot text of one analyzer source under `src/Analyzers/InternalAnalyzers`.
    /// @param fileName The analyzer file name, e.g. `StructFieldDefsReadAnalyzer.cs`.
    /// @returns The pinned C# source.
    internal func Analyzer(fileName string) string -> Read(AnalyzersDirectory + fileName + ".txt")

    /// Reads a snapshot; an empty snapshot is an error, not an empty input.
    /// @param relativePath The path under `Fixtures/FrozenCompiler`.
    /// @returns The snapshot text.
    internal func Read(relativePath string) string {
        let path string? = FrozenCompilerSnapshots.Path(relativePath)
        let text = File.ReadAllText(path!!)
        if string.IsNullOrWhiteSpace(text) {
            throw InvalidOperationException("Frozen compiler snapshot '$relativePath' is empty.")
        }
        return text
    }

    /// The absolute path of a snapshot.
    /// @param relativePath The path under `Fixtures/FrozenCompiler`.
    /// @returns The path.
    internal func Path(relativePath string) string? -> TestFixtureSource.Resolve(
        "tools",
        "cs2gs",
        "Cs2Gs.Tests",
        "Fixtures",
        "FrozenCompiler",
        relativePath.Replace('/', Path.DirectorySeparatorChar)
    )

    /// The live text a snapshot is compared with: the whole live file, or for a
    /// region snapshot the tail of the live file that starts at the
    /// snapshot's first line (up to the end of the file, so the end does not
    /// depend on the snapshot's current length and a refresh stays complete). A region whose
    /// first line is not found throws, so a refresh can never write an empty
    /// snapshot.
    /// @param snapshot The snapshot text.
    /// @param live The live C# text.
    /// @param region Whether the snapshot mirrors only a region of the live file.
    /// @returns The live text to compare.
    internal func LiveText(snapshot string, live string, region bool) string {
        let normalizedLive = Normalize(live)
        if !region {
            return normalizedLive
        }
        let snapshotLines = Normalize(snapshot).TrimEnd('\n').Split('\n')
        let liveLines = normalizedLive.TrimEnd('\n').Split('\n')
        let start = Array.IndexOf(liveLines, snapshotLines[0])
        if start < 0 {
            throw InvalidOperationException(
                "The first line of the region snapshot is not in the live file: '${snapshotLines[0]}'. Re-point the snapshot at the moved or edited region by hand."
            )
        }
        return string.Join("\n", liveLines, start, liveLines.Length - start) + "\n"
    }

    private func Normalize(text string) string -> text.ReplaceLineEndings("\n")
}
