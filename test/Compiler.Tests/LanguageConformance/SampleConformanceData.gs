// <copyright file="SampleConformanceData.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests.LanguageConformance

import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection

internal shared class SampleConformanceData {
    func GetSingleFileSamples(samplesDirectory string?) IReadOnlyList[string] -> Directory
        .EnumerateFiles(samplesDirectory!!, "*.gs", SearchOption.TopDirectoryOnly)
        .Where((path string) -> File.Exists(Path.ChangeExtension(path, ".golden")))
        .Select(Path.GetFileName)
        .OrderBy((name string) -> name, StringComparer.Ordinal)
        .ToArray()

    func GetMultiFileSamples(samplesDirectory string?) IReadOnlyList[string] -> Directory
        .EnumerateDirectories(samplesDirectory!!)
        .Where((path string) -> !string.Equals(Path.GetFileName(path), "aspirational", StringComparison.Ordinal))
        .Where(
        (path string) -> File.Exists(Path.Combine(path, Path.GetFileName(path) + ".golden")) &&
            Directory
            .EnumerateFiles(path, "*.gs").Any()
    )
        .Select((path string) -> (Path.GetFileName(path) + "/"))
        .OrderBy((name string) -> name, StringComparer.Ordinal)
        .ToArray()

    func LocateSamplesDirectory(testAssembly Assembly) string? {
        var directory DirectoryInfo? = DirectoryInfo(Path.GetDirectoryName(testAssembly.Location)!!)
        while directory != nil {
            let candidate = Path.Combine(directory.FullName, "samples")
            if Directory.Exists(candidate) && RepositoryRootMarker.IsRoot(directory.FullName) {
                return candidate
            }
            directory = directory.Parent
        }
        return nil
    }

    func ReadNormalizedFile(path string) string -> NormalizeLineEndings(File.ReadAllText(path))

    func NormalizeLineEndings(text string) string -> text.ReplaceLineEndings("\n")
}
