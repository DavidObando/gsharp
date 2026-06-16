// <copyright file="ReferenceMetadataIndex.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// A serializable snapshot of the full-type-name → declaring-assembly index that
/// <see cref="ReferenceResolver"/> derives from a reference set. It exists so the
/// language server's cross-session cold-start cache (ADR-0107) can persist the
/// expensive metadata enumeration (<c>Assembly.GetTypes()</c> /
/// <c>Assembly.GetForwardedTypes()</c> over the project's whole reference closure)
/// and replay it on a subsequent process start instead of recomputing it.
/// </summary>
/// <remarks>
/// The index is a <em>pure function of the (ordered) reference set</em>: it carries
/// no source-derived state, so it is safe to fingerprint on the references alone.
/// It stores only type-name strings plus each assembly's identity — never CLR
/// <see cref="Type"/> objects, which are bound to a live
/// <see cref="System.Reflection.MetadataLoadContext"/> and cannot survive a process
/// exit. A consumer re-creates the load context, validates the recorded assembly
/// identities against the freshly-loaded ones, and then materialises individual
/// <see cref="Type"/> instances lazily by name (see
/// <see cref="ReferenceResolver.TryUseMetadataIndex"/>). Because the recorded names
/// are exactly those the eager enumeration produced, warm resolution is a superset
/// of cold resolution (with an order-preserving scan fallback), so it can never
/// silently resolve <em>fewer</em> or <em>different</em> types than the cold path.
/// <para>
/// ADR-0107 (revised) persists the index as a human-readable <em>text</em> section
/// (<see cref="SectionHeader"/>) inside the single <c>.lscache</c> descriptor:
/// newline-delimited type names grouped per assembly. On the Oahu closure (~25 000
/// names, ~1.3 MB) this parses in ~4 ms — indistinguishable in practice from a
/// binary encoding (~2 ms) and far below the ~120 ms enumeration it replaces — so
/// there is no reason to maintain a separate binary blob.
/// </para>
/// </remarks>
public sealed class ReferenceMetadataIndex
{
    /// <summary>
    /// The on-disk text format version for the <see cref="SectionHeader"/>
    /// section. Bump whenever the section layout changes so that an older or
    /// newer payload is rejected (cold rebuild) rather than misread. This is
    /// independent of the cache <em>descriptor</em> version owned by the
    /// language server, and is folded into the descriptor fingerprint.
    /// </summary>
    public const int FormatVersion = 2;

    /// <summary>
    /// The INI-style section header under which the index is serialized inside
    /// the <c>.lscache</c> descriptor. The section is always written last so
    /// its newline-delimited body runs to end-of-file.
    /// </summary>
    public const string SectionHeader = "[metadataIndex]";

    // Conservative sanity bounds so a corrupt count line cannot drive an
    // unbounded allocation before the per-entry reads fail. The Oahu closure is
    // ~360 assemblies and ~25k names in its largest assembly; these ceilings sit
    // far above any realistic reference set.
    private const int MaxAssemblies = 1 << 16;
    private const int MaxTypeNamesPerAssembly = 1 << 22;

    private readonly ImmutableArray<string> assemblyIdentities;
    private readonly ImmutableArray<ImmutableArray<string>> typeNamesByAssembly;

    private ReferenceMetadataIndex(
        ImmutableArray<string> assemblyIdentities,
        ImmutableArray<ImmutableArray<string>> typeNamesByAssembly)
    {
        this.assemblyIdentities = assemblyIdentities;
        this.typeNamesByAssembly = typeNamesByAssembly;
    }

    /// <summary>
    /// Gets the recorded assembly identities (<see cref="System.Reflection.AssemblyName.FullName"/>),
    /// one per assembly, in the same order the producing
    /// <see cref="ReferenceResolver"/> searches them. Consumers validate these
    /// against the freshly-loaded reference set before trusting the payload.
    /// </summary>
    public ImmutableArray<string> AssemblyIdentities => assemblyIdentities;

    /// <summary>
    /// Creates an index from per-assembly identities and their defined +
    /// forwarded type full-names. The two arrays must be the same length; entry
    /// <c>i</c> of <paramref name="typeNamesByAssembly"/> lists the type names
    /// declared (or forwarded) by the assembly whose identity is entry <c>i</c>
    /// of <paramref name="assemblyIdentities"/>.
    /// </summary>
    /// <param name="assemblyIdentities">Assembly full names in search order.</param>
    /// <param name="typeNamesByAssembly">Type full-names per assembly.</param>
    /// <returns>A new <see cref="ReferenceMetadataIndex"/>.</returns>
    public static ReferenceMetadataIndex Create(
        ImmutableArray<string> assemblyIdentities,
        ImmutableArray<ImmutableArray<string>> typeNamesByAssembly)
    {
        if (assemblyIdentities.Length != typeNamesByAssembly.Length)
        {
            throw new ArgumentException(
                "Assembly identity and type-name arrays must have the same length.",
                nameof(typeNamesByAssembly));
        }

        return new ReferenceMetadataIndex(assemblyIdentities, typeNamesByAssembly);
    }

    /// <summary>
    /// Builds the merged full-name → assembly-index map with <em>first-writer-wins</em>
    /// precedence (the first assembly, in search order, that declares a given name
    /// owns it). This mirrors the precedence of <see cref="ReferenceResolver"/>'s
    /// eager type-name index so warm and cold resolution agree.
    /// </summary>
    /// <returns>A dictionary mapping a type full name to the index of its declaring assembly.</returns>
    public Dictionary<string, int> ToNameIndex()
    {
        // Pre-size generously; the Oahu reference set produces ~25k names.
        var index = new Dictionary<string, int>(capacity: 1 << 15, StringComparer.Ordinal);
        for (var i = 0; i < typeNamesByAssembly.Length; i++)
        {
            foreach (var name in typeNamesByAssembly[i])
            {
                if (name is not null && !index.ContainsKey(name))
                {
                    index[name] = i;
                }
            }
        }

        return index;
    }

    /// <summary>
    /// Serialises this index as the <see cref="SectionHeader"/> text section to
    /// <paramref name="writer"/>. The section begins with a short <c>#</c>
    /// comment, then <c>formatVersion=</c> and <c>assemblyCount=</c>, then one
    /// block per assembly: an <c>assembly=&lt;identity&gt;</c> line, a
    /// <c>typeNameCount=&lt;n&gt;</c> line, and exactly <c>n</c> newline-delimited
    /// type full-names. The traversal order is fixed so identical inputs always
    /// produce identical text, which lets the language server hash the section
    /// for integrity. The caller must write this section <em>last</em> in the
    /// descriptor so the body runs to end-of-file.
    /// </summary>
    /// <param name="writer">The destination text writer.</param>
    public void WriteTextSection(TextWriter writer)
    {
        if (writer is null)
        {
            throw new ArgumentNullException(nameof(writer));
        }

        writer.Write(SectionHeader);
        writer.Write('\n');
        writer.Write("# Reference-metadata type-name index (ADR-0107): per referenced assembly,\n");
        writer.Write("# its identity followed by the full type names it defines or forwards, in\n");
        writer.Write("# resolver search order. Newline-delimited; ~4 ms to parse for ~25k names.\n");
        writer.Write("formatVersion=");
        writer.Write(FormatVersion.ToString(CultureInfo.InvariantCulture));
        writer.Write('\n');
        writer.Write("assemblyCount=");
        writer.Write(assemblyIdentities.Length.ToString(CultureInfo.InvariantCulture));
        writer.Write('\n');

        for (var i = 0; i < assemblyIdentities.Length; i++)
        {
            var names = typeNamesByAssembly[i];
            writer.Write('\n');
            writer.Write("assembly=");
            writer.Write(assemblyIdentities[i] ?? string.Empty);
            writer.Write('\n');
            writer.Write("typeNameCount=");
            writer.Write(names.Length.ToString(CultureInfo.InvariantCulture));
            writer.Write('\n');
            foreach (var name in names)
            {
                writer.Write(name ?? string.Empty);
                writer.Write('\n');
            }
        }
    }

    /// <summary>
    /// Attempts to parse the <see cref="SectionHeader"/> section out of a
    /// descriptor's full set of <paramref name="lines"/> (the section is located
    /// by its header and read to end-of-file). This never throws: any structural
    /// problem (missing header, bad format version, a malformed or out-of-bounds
    /// count, truncation) is reported by returning <see langword="false"/> so the
    /// caller falls back to a cold rebuild. Under-trusting a payload is always
    /// safe; mis-reading one would be a correctness bug.
    /// </summary>
    /// <param name="lines">All descriptor lines, in order.</param>
    /// <param name="index">The parsed index on success; otherwise <see langword="null"/>.</param>
    /// <returns><see langword="true"/> when a well-formed section was read.</returns>
    public static bool TryReadTextSection(IReadOnlyList<string> lines, out ReferenceMetadataIndex index)
    {
        index = null;
        if (lines is null)
        {
            return false;
        }

        var cursor = -1;
        for (var i = 0; i < lines.Count; i++)
        {
            if (string.Equals(lines[i]?.Trim(), SectionHeader, StringComparison.Ordinal))
            {
                cursor = i + 1;
                break;
            }
        }

        if (cursor < 0)
        {
            return false;
        }

        try
        {
            if (!TryReadIntField(lines, ref cursor, "formatVersion", out var formatVersion)
                || formatVersion != FormatVersion)
            {
                return false;
            }

            if (!TryReadIntField(lines, ref cursor, "assemblyCount", out var assemblyCount)
                || assemblyCount < 0 || assemblyCount > MaxAssemblies)
            {
                return false;
            }

            var identities = ImmutableArray.CreateBuilder<string>(assemblyCount);
            var names = ImmutableArray.CreateBuilder<ImmutableArray<string>>(assemblyCount);
            for (var a = 0; a < assemblyCount; a++)
            {
                if (!TryReadStringField(lines, ref cursor, "assembly", out var identity))
                {
                    return false;
                }

                if (!TryReadIntField(lines, ref cursor, "typeNameCount", out var nameCount)
                    || nameCount < 0 || nameCount > MaxTypeNamesPerAssembly)
                {
                    return false;
                }

                var perAssembly = ImmutableArray.CreateBuilder<string>(nameCount);
                for (var n = 0; n < nameCount; n++)
                {
                    if (cursor >= lines.Count)
                    {
                        return false;
                    }

                    perAssembly.Add(lines[cursor] ?? string.Empty);
                    cursor++;
                }

                identities.Add(identity);
                names.Add(perAssembly.MoveToImmutable());
            }

            index = new ReferenceMetadataIndex(identities.MoveToImmutable(), names.MoveToImmutable());
            return true;
        }
        catch (OutOfMemoryException)
        {
            // A corrupt count could request an absurd allocation; the bounds
            // checks above guard the common cases, this is the backstop.
            return false;
        }
    }

    // Advances past blank/comment lines and reads the next `key=value` line,
    // verifying the key matches and the value parses as an int. Used for the
    // structural header/count lines only (never for the verbatim type-name
    // lines, which are read positionally by count).
    private static bool TryReadIntField(IReadOnlyList<string> lines, ref int cursor, string key, out int value)
    {
        value = 0;
        if (!TryReadStringField(lines, ref cursor, key, out var raw))
        {
            return false;
        }

        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
    }

    // Skips blank and `#` comment lines, then requires the next line to be
    // `<key>=<value>`; returns the value. A non-matching key or end-of-input
    // returns false (a conservative parse failure).
    private static bool TryReadStringField(IReadOnlyList<string> lines, ref int cursor, string key, out string value)
    {
        value = null;
        while (cursor < lines.Count)
        {
            var line = lines[cursor];
            var trimmed = line?.Trim();
            if (string.IsNullOrEmpty(trimmed) || trimmed[0] == '#')
            {
                cursor++;
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0 || !string.Equals(line.Substring(0, eq), key, StringComparison.Ordinal))
            {
                return false;
            }

            value = line.Substring(eq + 1);
            cursor++;
            return true;
        }

        return false;
    }
}
