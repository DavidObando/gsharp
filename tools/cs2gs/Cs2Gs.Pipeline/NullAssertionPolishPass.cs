// <copyright file="NullAssertionPolishPass.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #3501 (!! reduction): strips the <c>!!</c> assertions gsc itself
/// reported as redundant (GS0536 — the operand is already non-nullable,
/// statically or through smart-cast narrowing). The compiler is the single
/// source of truth for narrowing, so this pass performs no flow analysis of
/// its own: it deletes exactly the warned token spans and lets the follow-up
/// compile confirm the result. This also matches C# semantics more closely —
/// the C# <c>!</c> the assertion came from performs no runtime check at all.
/// </summary>
public static class NullAssertionPolishPass
{
    /// <summary>The diagnostic id this pass consumes.</summary>
    public const string DiagnosticId = "GS0536";

    /// <summary>
    /// Deletes every GS0536-flagged <c>!!</c> span from the given emitted
    /// files. Spans are applied bottom-up per file so earlier deletions never
    /// shift later coordinates, and each span is verified to hold exactly
    /// <c>!!</c> before deletion (a mismatch skips the span rather than
    /// corrupting the file).
    /// </summary>
    /// <param name="diagnostics">The compile run's parsed diagnostics.</param>
    /// <param name="emittedGsFiles">The emitted .gs file paths owned by this app.</param>
    /// <param name="strippableRoot">
    /// Optional directory under which ANY emitted <c>.gs</c> may be polished —
    /// an app's SDK build also compiles its project references, and a
    /// dependency whose own compile stage never ran (translation-unsupported)
    /// still carries redundant assertions that fail this app's
    /// warnings-as-errors build.
    /// </param>
    /// <returns>The number of assertions removed.</returns>
    public static int Strip(
        IReadOnlyList<GscDiagnostic> diagnostics,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot = null)
    {
        if (diagnostics is null || diagnostics.Count == 0 || emittedGsFiles is null || emittedGsFiles.Count == 0)
        {
            return 0;
        }

        Dictionary<string, string> ownedByFullPath = BuildOwnedIndex(emittedGsFiles);

        var stripped = 0;
        IEnumerable<IGrouping<string, GscDiagnostic>> byFile = diagnostics
            .Where(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal)
                && d.Line == d.EndLine
                && d.EndColumn - d.Column == 2)
            .GroupBy(d => ResolveStrippableFile(d.File, ownedByFullPath, strippableRoot))
            .Where(g => g.Key != null);

        foreach (IGrouping<string, GscDiagnostic> group in byFile)
        {
            string[] lines = File.ReadAllLines(group.Key);
            var changed = false;
            foreach (GscDiagnostic diagnostic in group
                .Distinct(SpanComparer.Instance)
                .OrderByDescending(d => d.Line)
                .ThenByDescending(d => d.Column))
            {
                int lineIndex = diagnostic.Line - 1;
                int start = diagnostic.Column - 1;
                if (lineIndex < 0 || lineIndex >= lines.Length)
                {
                    continue;
                }

                string line = lines[lineIndex];
                if (start < 0 || start + 2 > line.Length
                    || line[start] != '!' || line[start + 1] != '!')
                {
                    continue;
                }

                lines[lineIndex] = line.Remove(start, 2);
                changed = true;
                stripped++;
            }

            if (changed)
            {
                File.WriteAllLines(group.Key, lines);
            }
        }

        return stripped;
    }

    /// <summary>
    /// Lists the files a <see cref="Strip"/> call with the same arguments
    /// would touch, so callers can snapshot them for rollback first.
    /// </summary>
    /// <param name="diagnostics">The compile run's parsed diagnostics.</param>
    /// <param name="emittedGsFiles">The emitted .gs file paths owned by this app.</param>
    /// <param name="strippableRoot">The optional shared emitted-output root.</param>
    /// <returns>The distinct resolved file paths.</returns>
    public static IReadOnlyCollection<string> CandidateFiles(
        IReadOnlyList<GscDiagnostic> diagnostics,
        IReadOnlyCollection<string> emittedGsFiles,
        string strippableRoot = null)
    {
        if (diagnostics is null || diagnostics.Count == 0 || emittedGsFiles is null || emittedGsFiles.Count == 0)
        {
            return Array.Empty<string>();
        }

        Dictionary<string, string> ownedByFullPath = BuildOwnedIndex(emittedGsFiles);

        return diagnostics
            .Where(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal))
            .Select(d => ResolveStrippableFile(d.File, ownedByFullPath, strippableRoot))
            .Where(f => f != null)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    // Indexes the app-owned emitted files by BOTH the raw full path and the
    // symlink-canonical path, so a diagnostic echoing either spelling matches.
    private static Dictionary<string, string> BuildOwnedIndex(IReadOnlyCollection<string> emittedGsFiles)
    {
        var index = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string file in emittedGsFiles)
        {
            if (!File.Exists(file))
            {
                continue;
            }

            string full = Path.GetFullPath(file);
            index.TryAdd(full, file);
            index.TryAdd(CanonicalizePath(full), file);
        }

        return index;
    }

    private static string ResolveStrippableFile(
        string diagnosticFile,
        IReadOnlyDictionary<string, string> ownedByFullPath,
        string strippableRoot)
    {
        if (string.IsNullOrEmpty(diagnosticFile))
        {
            return null;
        }

        string normalized;
        try
        {
            normalized = Path.GetFullPath(diagnosticFile);
        }
        catch (Exception e) when (e is ArgumentException or PathTooLongException or NotSupportedException)
        {
            return null;
        }

        // Issue #3501: gsc echoes SYMLINK-RESOLVED paths on macOS
        // (`/private/tmp/…`) while the pipeline's owned/root paths keep the
        // spelling it was invoked with (`/tmp/…`), so both comparisons below
        // run over canonical real paths.
        string canonical = CanonicalizePath(normalized);
        if (ownedByFullPath.TryGetValue(normalized, out string owned)
            || ownedByFullPath.TryGetValue(canonical, out owned))
        {
            return owned;
        }

        if (string.IsNullOrEmpty(strippableRoot)
            || !normalized.EndsWith(".gs", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(normalized))
        {
            return null;
        }

        string root = Path.GetFullPath(strippableRoot)
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string canonicalRoot = CanonicalizePath(root.TrimEnd(Path.DirectorySeparatorChar))
            + Path.DirectorySeparatorChar;
        return normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            || canonical.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase)
                ? normalized
                : null;
    }

    // Resolves directory symlinks in the path's ancestry (macOS `/tmp` →
    // `/private/tmp`) by round-tripping through the filesystem; falls back to
    // the input when nothing exists to resolve against.
    private static string CanonicalizePath(string path)
    {
        try
        {
            string directory = Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
            {
                return path;
            }

            var info = new DirectoryInfo(directory);
            string resolvedDirectory = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName
                ?? ResolveAncestrySymlinks(directory);
            return Path.Combine(resolvedDirectory, Path.GetFileName(path));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return path;
        }
    }

    private static string ResolveAncestrySymlinks(string directory)
    {
        // `ResolveLinkTarget` only resolves when the FINAL component is the
        // link; `/tmp/foo/bar` needs `/tmp` itself resolved. Walk up until a
        // component resolves, then reattach the remainder.
        string current = directory;
        var suffix = new List<string>();
        while (!string.IsNullOrEmpty(current))
        {
            if (Directory.Exists(current))
            {
                string resolved = new DirectoryInfo(current)
                    .ResolveLinkTarget(returnFinalTarget: true)?.FullName;
                if (resolved != null)
                {
                    suffix.Reverse();
                    return suffix.Aggregate(resolved, Path.Combine);
                }
            }

            string name = Path.GetFileName(current);
            string parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(parent) || parent == current)
            {
                break;
            }

            suffix.Add(name);
            current = parent;
        }

        return directory;
    }

    private sealed class SpanComparer : IEqualityComparer<GscDiagnostic>
    {
        public static readonly SpanComparer Instance = new SpanComparer();

        public bool Equals(GscDiagnostic x, GscDiagnostic y) =>
            x!.Line == y!.Line && x.Column == y.Column;

        public int GetHashCode(GscDiagnostic obj) => (obj.Line * 397) ^ obj.Column;
    }
}
