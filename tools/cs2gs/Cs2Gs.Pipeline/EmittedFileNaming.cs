// <copyright file="EmittedFileNaming.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Derives unique <c>.gs</c> output file names from C# source paths (issue #1189).
/// Two C# documents that share a base name in different folders (e.g.
/// <c>Types/Enums.cs</c> and <c>Diagnostics/Enums.cs</c>) would otherwise both map
/// to <c>Enums.gs</c> and the second would silently overwrite the first, losing the
/// translated code and producing spurious downstream <c>GS0113</c> diagnostics.
/// </summary>
internal static class EmittedFileNaming
{
    /// <summary>
    /// Returns a <c>.gs</c> file name for <paramref name="sourceFilePath"/> that is
    /// unique within <paramref name="usedNames"/> (compared case-insensitively, to
    /// stay safe on case-insensitive macOS/Windows filesystems). When the plain base
    /// name collides, containing directory segments are prepended deterministically
    /// (<c>Types.Enums.gs</c>, <c>Diagnostics.Enums.gs</c>); if every directory
    /// segment has been consumed and a collision still remains, a numeric counter is
    /// appended. The chosen name is added to <paramref name="usedNames"/> before
    /// returning, so callers can pass the same set through their document loop.
    /// </summary>
    /// <param name="sourceFilePath">The originating C# source file path.</param>
    /// <param name="usedNames">
    /// The set of <c>.gs</c> names already emitted in this run. Must be created with a
    /// case-insensitive comparer (e.g. <see cref="StringComparer.OrdinalIgnoreCase"/>).
    /// </param>
    /// <returns>A unique <c>.gs</c> file name.</returns>
    public static string UniqueGsFileName(string sourceFilePath, ISet<string> usedNames)
    {
        if (usedNames is null)
        {
            throw new ArgumentNullException(nameof(usedNames));
        }

        string baseName = SanitizeSegment(Path.GetFileNameWithoutExtension(sourceFilePath ?? string.Empty));
        if (string.IsNullOrEmpty(baseName))
        {
            baseName = "File";
        }

        IReadOnlyList<string> dirSegments = DirectorySegmentsNearestFirst(sourceFilePath);

        string candidate = baseName + ".gs";
        int step = 0;
        while (usedNames.Contains(candidate))
        {
            step++;
            if (step <= dirSegments.Count)
            {
                // Prepend the nearest `step` directory segments, ordered outer→inner
                // for readability (e.g. ["Types"] → "Types.Enums.gs").
                IEnumerable<string> prefix = dirSegments.Take(step).Reverse();
                candidate = string.Join(".", prefix) + "." + baseName + ".gs";
            }
            else
            {
                // Exhausted directory segments: fall back to a numeric counter on top
                // of the fully-qualified prefix.
                int counter = step - dirSegments.Count + 1;
                string allDirs = dirSegments.Count > 0
                    ? string.Join(".", dirSegments.Reverse()) + "."
                    : string.Empty;
                candidate = allDirs + baseName + "." + counter + ".gs";
            }
        }

        usedNames.Add(candidate);
        return candidate;
    }

    private static IReadOnlyList<string> DirectorySegmentsNearestFirst(string sourceFilePath)
    {
        if (string.IsNullOrEmpty(sourceFilePath))
        {
            return Array.Empty<string>();
        }

        string dir = Path.GetDirectoryName(sourceFilePath);
        if (string.IsNullOrEmpty(dir))
        {
            return Array.Empty<string>();
        }

        // Split on both separators so the result is platform-independent.
        string[] parts = dir.Split(
            new[] { '/', '\\' },
            StringSplitOptions.RemoveEmptyEntries);

        var segments = new List<string>(parts.Length);
        for (int i = parts.Length - 1; i >= 0; i--)
        {
            string sanitized = SanitizeSegment(parts[i]);
            if (sanitized.Length == 0 || sanitized == "." || sanitized == "..")
            {
                continue;
            }

            segments.Add(sanitized);
        }

        return segments;
    }

    private static string SanitizeSegment(string segment)
    {
        if (string.IsNullOrEmpty(segment))
        {
            return string.Empty;
        }

        char[] chars = segment.ToCharArray();
        for (int i = 0; i < chars.Length; i++)
        {
            char c = chars[i];
            if (char.IsLetterOrDigit(c) || c == '_' || c == '-')
            {
                continue;
            }

            chars[i] = '_';
        }

        return new string(chars).Trim('_');
    }
}
