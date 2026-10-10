// <copyright file="CorePublicApiAllowance.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;

namespace GSharp.Core.Tests.PublicApi;

/// <summary>
/// ADR-0199: the one narrow, exact allow-list of members the Core public-API
/// snapshot tolerates on a G#-built <c>GSharp.Core.dll</c> but the native C#
/// build does not have. A body-only C# record has no <c>Deconstruct</c>; the
/// same record migrated to a G# <c>data class</c> gets G#'s synthesized one
/// (G# keeps its own <c>Deconstruct</c> rule, ADR-0199 item 4).
/// <para>
/// The allowance is "may be present", never "must": the native build has none
/// of the entries and passes without them. It is not a general additive waiver.
/// An entry is honored only when it is a public <c>Deconstruct</c> method on a
/// record type (one with a synthesized <c>&lt;Clone&gt;$</c> member). A new
/// synthesized member needs an ADR amendment and its own list entry.
/// </para>
/// </summary>
internal static class CorePublicApiAllowance
{
    internal const string AllowanceFileName = "gsharp-core-public-api-allowed-additions.txt";

    private const string Separator = " | ";
    private const string RecordCloneMarker = " <Clone>$()";
    private const string DeconstructPrefix = "  method public Void Deconstruct(";

    /// <summary>One allow-list entry: a type's full name and one rendered member line.</summary>
    internal readonly record struct Entry(string TypeName, string MemberLine);

    /// <summary>The outcome of applying the allow-list to a rendered surface.</summary>
    internal sealed class Result
    {
        public Result(IReadOnlyList<string> lines, IReadOnlyList<string> present)
        {
            this.Lines = lines;
            this.Present = present;
        }

        /// <summary>Gets the rendered surface with the allowed additions removed.</summary>
        public IReadOnlyList<string> Lines { get; }

        /// <summary>Gets the allowed additions that were present, for the test output.</summary>
        public IReadOnlyList<string> Present { get; }
    }

    /// <summary>
    /// Parses the allow-list file: <c>#</c> comments and blank lines are
    /// skipped, every other line is <c>Full.Type.Name | rendered member line</c>.
    /// </summary>
    /// <param name="text">The file text.</param>
    /// <returns>The entries in file order.</returns>
    internal static IReadOnlyList<Entry> Parse(string text)
    {
        var entries = new List<Entry>();
        foreach (string raw in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            if (raw.Trim().Length == 0 || raw.TrimStart().StartsWith('#'))
            {
                continue;
            }

            int split = raw.IndexOf(Separator, StringComparison.Ordinal);
            if (split <= 0)
            {
                throw new InvalidOperationException($"Malformed allowed-additions line (want 'Type | member'): {raw}");
            }

            entries.Add(new Entry(raw[..split].Trim(), "  " + raw[(split + Separator.Length)..].Trim()));
        }

        return entries;
    }

    /// <summary>
    /// Removes the allowed additions from <paramref name="rendered"/> so the
    /// remainder can be compared with the native snapshot. Throws when an
    /// entry is not a record <c>Deconstruct</c>, or names a type that is not a
    /// record in the rendered surface.
    /// </summary>
    /// <param name="rendered">The rendered public API lines.</param>
    /// <param name="allowance">The allow-list entries.</param>
    /// <returns>The remaining lines and the allowed additions that were present.</returns>
    internal static Result Apply(IReadOnlyList<string> rendered, IReadOnlyList<Entry> allowance)
    {
        var drop = new HashSet<int>();
        var present = new List<string>();
        foreach (Entry entry in allowance)
        {
            if (!entry.MemberLine.StartsWith(DeconstructPrefix, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Allowed addition is not a public Deconstruct method (ADR-0199 allows nothing else): {entry.TypeName} | {entry.MemberLine.Trim()}");
            }

            int header = FindType(rendered, entry.TypeName);
            if (header < 0)
            {
                continue;
            }

            int end = header + 1;
            while (end < rendered.Count && !rendered[end].StartsWith("type ", StringComparison.Ordinal))
            {
                end++;
            }

            bool isRecord = false;
            int match = -1;
            for (int i = header + 1; i < end; i++)
            {
                isRecord |= rendered[i].Contains(RecordCloneMarker, StringComparison.Ordinal);
                if (string.Equals(rendered[i], entry.MemberLine, StringComparison.Ordinal))
                {
                    match = i;
                }
            }

            if (match < 0)
            {
                continue;
            }

            if (!isRecord)
            {
                throw new InvalidOperationException(
                    $"Allowed addition names a type that is not a record: {entry.TypeName} | {entry.MemberLine.Trim()}");
            }

            drop.Add(match);
            present.Add($"{entry.TypeName} | {entry.MemberLine.Trim()}");
        }

        var lines = rendered.Where((_, index) => !drop.Contains(index)).ToList();
        return new Result(lines, present);
    }

    private static int FindType(IReadOnlyList<string> rendered, string typeName)
    {
        for (int i = 0; i < rendered.Count; i++)
        {
            string line = rendered[i];
            if (!line.StartsWith("type ", StringComparison.Ordinal))
            {
                continue;
            }

            int colon = line.IndexOf(" : ", StringComparison.Ordinal);
            string head = colon < 0 ? line : line[..colon];
            if (head.EndsWith(" " + typeName, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }
}
