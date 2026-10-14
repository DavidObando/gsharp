// <copyright file="EmittedFileNaming.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Derives unique `.gs` output file names from C# source paths (issue #1189).
/// Two C# documents that share a base name in different folders (e.g.
/// `Types/Enums.cs` and `Diagnostics/Enums.cs`) would otherwise both map
/// to `Enums.gs` and the second would silently overwrite the first, losing the
/// translated code and producing spurious downstream `GS0113` diagnostics.
internal shared class EmittedFileNaming {
    /// Returns a `.gs` file name for [`sourceFilePath`](paramref) that is
    /// unique within [`usedNames`](paramref) (compared case-insensitively, to
    /// stay safe on case-insensitive macOS/Windows filesystems). When the plain base
    /// name collides, containing directory segments are prepended deterministically
    /// (`Types.Enums.gs`, `Diagnostics.Enums.gs`); if every directory
    /// segment has been consumed and a collision still remains, a numeric counter is
    /// appended. The chosen name is added to [`usedNames`](paramref) before
    /// returning, so callers can pass the same set through their document loop.
    /// @param sourceFilePath The originating C# source file path.
    /// @param usedNames The set of `.gs` names already emitted in this run. Must be created with a
    /// case-insensitive comparer (e.g. (cref:StringComparer.OrdinalIgnoreCase)).
    /// @returns A unique `.gs` file name.
    func UniqueGsFileName(sourceFilePath string, usedNames ISet[string]?) string {
        if usedNames == nil {
            throw ArgumentNullException("usedNames")
        }
        var baseName = SanitizeSegment(Path.GetFileNameWithoutExtension(sourceFilePath ?? string.Empty))
        if string.IsNullOrEmpty(baseName) {
            baseName = "File"
        }
        let dirSegments = DirectorySegmentsNearestFirst(sourceFilePath)
        var candidate = baseName + ".gs"
        var step = 0
        while usedNames.Contains(candidate) {
            step++
            if step <= dirSegments.Count {
                // Prepend the nearest `step` directory segments, ordered outer→inner
                // for readability (e.g. ["Types"] → "Types.Enums.gs").
                let prefix = dirSegments.Take(step).Reverse()
                candidate = string.Join(".", prefix) + "." + baseName + ".gs"
            } else {
                // Exhausted directory segments: fall back to a numeric counter on top
                // of the fully-qualified prefix.
                let counter = step - dirSegments.Count + 1
                let allDirs = if dirSegments.Count > 0 {
                    string.Join(".", dirSegments.Reverse()) + "."
                } else {
                    string.Empty
                }
                candidate = allDirs + baseName + "." + counter.ToString() + ".gs"
            }
        }
        usedNames.Add(candidate)
        return candidate
    }

    private func DirectorySegmentsNearestFirst(sourceFilePath string) IReadOnlyList[string] {
        if string.IsNullOrEmpty(sourceFilePath) {
            return Array.Empty[string]()
        }
        let dir string? = Path.GetDirectoryName(sourceFilePath)
        if string.IsNullOrEmpty(dir) {
            return Array.Empty[string]()
        }
        // Split on both separators so the result is platform-independent.
        let parts = dir.Split([]char{'/', '\\'}, StringSplitOptions.RemoveEmptyEntries)
        let segments = List[string](parts.Length)
        for var i = parts.Length - 1; i >= 0; i-- {
            let sanitized = SanitizeSegment(parts[i])
            if sanitized.Length == 0 || sanitized == "." || sanitized == ".." {
                continue
            }
            segments.Add(sanitized)
        }
        return segments
    }

    private func SanitizeSegment(segment string) string {
        if string.IsNullOrEmpty(segment) {
            return string.Empty
        }
        let chars = segment.ToCharArray()
        for var i = 0; i < chars.Length; i++ {
            let c = chars[i]
            if char.IsLetterOrDigit(c) || c == '_' || c == '-' {
                continue
            }
            chars[i] = '_'
        }
        return String(chars).Trim('_')
    }
}
