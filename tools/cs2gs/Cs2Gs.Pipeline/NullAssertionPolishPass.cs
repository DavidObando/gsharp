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
    /// <returns>The number of assertions removed.</returns>
    public static int Strip(
        IReadOnlyList<GscDiagnostic> diagnostics,
        IReadOnlyCollection<string> emittedGsFiles)
    {
        if (diagnostics is null || diagnostics.Count == 0 || emittedGsFiles is null || emittedGsFiles.Count == 0)
        {
            return 0;
        }

        Dictionary<string, string> ownedByFullPath = emittedGsFiles
            .Where(File.Exists)
            .GroupBy(p => Path.GetFullPath(p), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

        var stripped = 0;
        IEnumerable<IGrouping<string, GscDiagnostic>> byFile = diagnostics
            .Where(d => string.Equals(d.Id, DiagnosticId, StringComparison.Ordinal)
                && d.Line == d.EndLine
                && d.EndColumn - d.Column == 2)
            .GroupBy(d => ResolveOwnedFile(d.File, ownedByFullPath))
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

    private static string ResolveOwnedFile(
        string diagnosticFile,
        IReadOnlyDictionary<string, string> ownedByFullPath)
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

        return ownedByFullPath.TryGetValue(normalized, out string owned) ? owned : null;
    }

    private sealed class SpanComparer : IEqualityComparer<GscDiagnostic>
    {
        public static readonly SpanComparer Instance = new SpanComparer();

        public bool Equals(GscDiagnostic x, GscDiagnostic y) =>
            x!.Line == y!.Line && x.Column == y.Column;

        public int GetHashCode(GscDiagnostic obj) => (obj.Line * 397) ^ obj.Column;
    }
}
