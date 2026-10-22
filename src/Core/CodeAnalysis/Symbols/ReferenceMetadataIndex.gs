// <copyright file="ReferenceMetadataIndex.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.IO
import System.Linq

/// A serializable snapshot of the full-type-name → declaring-assembly index that
/// (cref:ReferenceResolver) derives from a reference set. It exists so the
/// language server's cross-session cold-start cache (ADR-0107) can persist the
/// expensive metadata enumeration (`Assembly.GetTypes()` /
/// `Assembly.GetForwardedTypes()` over the project's whole reference closure)
/// and replay it on a subsequent process start instead of recomputing it.
/// @remarks The index is a <em>pure function of the (ordered) reference set</em>: it carries
/// no source-derived state, so it is safe to fingerprint on the references alone.
/// It stores only type-name strings plus each assembly's identity — never CLR
/// (cref:Type) objects, which are bound to a live
/// (cref:System.Reflection.MetadataLoadContext) and cannot survive a process
/// exit. A consumer re-creates the load context, validates the recorded assembly
/// identities and content fingerprints against the freshly-loaded ones, then materialises individual
/// (cref:Type) instances lazily by name (see
/// (cref:ReferenceResolver.TryUseMetadataIndex)). Because the recorded names
/// are exactly those the eager enumeration produced, warm resolution is a superset
/// of cold resolution (with an order-preserving scan fallback), so it can never
/// silently resolve <em>fewer</em> or <em>different</em> types than the cold path.
///
/// ADR-0107 (revised) persists the index as a human-readable <em>text</em> section
/// ((cref:SectionHeader)) inside the single `.lscache` descriptor:
/// newline-delimited type names grouped per assembly. On the Oahu closure (~25 000
/// names, ~1.3 MB) this parses in ~4 ms — indistinguishable in practice from a
/// binary encoding (~2 ms) and far below the ~120 ms enumeration it replaces — so
/// there is no reason to maintain a separate binary blob.
class ReferenceMetadataIndex {
    private let assemblyIdentities ImmutableArray[string]
    private let typeNamesByAssembly ImmutableArray[ImmutableArray[string]]
    private let contentFingerprints ImmutableArray[string]

    private init(
        assemblyIdentities ImmutableArray[string],
        typeNamesByAssembly ImmutableArray[ImmutableArray[string]],
        contentFingerprints ImmutableArray[string]
    ) {
        this.assemblyIdentities = assemblyIdentities
        this.typeNamesByAssembly = typeNamesByAssembly
        this.contentFingerprints = contentFingerprints
    }

    /// Gets the recorded assembly identities ((cref:System.Reflection.AssemblyName.FullName)),
    /// one per assembly, in the same order the producing
    /// (cref:ReferenceResolver) searches them. Consumers validate these
    /// against the freshly-loaded reference set before trusting the payload.
    prop AssemblyIdentities ImmutableArray[string] -> assemblyIdentities
    /// Gets content fingerprints in resolver search order. Empty entries cannot be adopted.
    prop ContentFingerprints ImmutableArray[string] -> contentFingerprints

    /// Gets the type names recorded for each assembly, in the same order as (cref:AssemblyIdentities).
    internal prop TypeNames ImmutableArray[ImmutableArray[string]] -> typeNamesByAssembly

    /// Builds the merged full-name → assembly-index map with <em>first-writer-wins</em>
    /// precedence (the first assembly, in search order, that declares a given name
    /// owns it). This mirrors the precedence of (cref:ReferenceResolver)'s
    /// eager type-name index so warm and cold resolution agree.
    /// @returns A dictionary mapping a type full name to the index of its declaring assembly.
    func ToNameIndex() Dictionary[string, int32] {
        // Pre-size generously; the Oahu reference set produces ~25k names.
        let index = Dictionary[string, int32](capacity: 1 << 15, StringComparer.Ordinal)
        for var i = 0; i < typeNamesByAssembly.Length; i++ {
            for name in typeNamesByAssembly[i] {
                if name != nil && !index.ContainsKey(name) {
                    index[name] = i
                }
            }
        }
        return index
    }

    /// Serialises this index as the (cref:SectionHeader) text section to
    /// [`writer`](paramref). The section begins with a short `#`
    /// comment, then `formatVersion=` and `assemblyCount=`, then one
    /// block per assembly: an `assembly=<identity>` line, a
    /// `typeNameCount=<n>` line, and exactly `n` newline-delimited
    /// type full-names. The traversal order is fixed so identical inputs always
    /// produce identical text, which lets the language server hash the section
    /// for integrity. The caller must write this section <em>last</em> in the
    /// descriptor so the body runs to end-of-file.
    /// @param writer The destination text writer.
    func WriteTextSection(writer TextWriter?) {
        if writer == nil {
            throw ArgumentNullException("writer")
        }
        writer.Write(SectionHeader)
        writer.Write('\n')
        writer.Write("# Reference-metadata type-name index (ADR-0107): per referenced assembly,\n")
        writer.Write("# its identity followed by the full type names it defines or forwards, in\n")
        writer.Write("# resolver search order. Newline-delimited; ~4 ms to parse for ~25k names.\n")
        writer.Write("formatVersion=")
        writer.Write(FormatVersion.ToString(CultureInfo.InvariantCulture))
        writer.Write('\n')
        writer.Write("assemblyCount=")
        writer.Write(assemblyIdentities.Length.ToString(CultureInfo.InvariantCulture))
        writer.Write('\n')
        for var i = 0; i < assemblyIdentities.Length; i++ {
            let names = typeNamesByAssembly[i]
            writer.Write('\n')
            writer.Write("assembly=")
            writer.Write(assemblyIdentities[i] ?? string.Empty)
            writer.Write('\n')
            writer.Write("contentFingerprint=")
            writer.Write(contentFingerprints[i])
            writer.Write('\n')
            writer.Write("typeNameCount=")
            writer.Write(names.Length.ToString(CultureInfo.InvariantCulture))
            writer.Write('\n')
            for name in names {
                writer.Write(name ?? string.Empty)
                writer.Write('\n')
            }
        }
    }

    shared {
        /// The on-disk text format version for the (cref:SectionHeader)
        /// section. Bump whenever the section layout changes so that an older or
        /// newer payload is rejected (cold rebuild) rather than misread. This is
        /// independent of the cache <em>descriptor</em> version owned by the
        /// language server, and is folded into the descriptor fingerprint.
        const FormatVersion int32 = 3

        /// The INI-style section header under which the index is serialized inside
        /// the `.lscache` descriptor. The section is always written last so
        /// its newline-delimited body runs to end-of-file.
        const SectionHeader string = "[metadataIndex]"

        // Conservative sanity bounds so a corrupt count line cannot drive an
        // unbounded allocation before the per-entry reads fail. The Oahu closure is
        // ~360 assemblies and ~25k names in its largest assembly; these ceilings sit
        // far above any realistic reference set.
        private const MaxAssemblies int32 = 1 << 16

        private const MaxTypeNamesPerAssembly int32 = 1 << 22

        /// Creates an index from per-assembly identities and their defined +
        /// forwarded type full-names. The two arrays must be the same length; entry
        /// `i` of [`typeNamesByAssembly`](paramref) lists the type names
        /// declared (or forwarded) by the assembly whose identity is entry `i`
        /// of [`assemblyIdentities`](paramref).
        /// @param assemblyIdentities Assembly full names in search order.
        /// @param typeNamesByAssembly Type full-names per assembly.
        /// @returns A new (cref:ReferenceMetadataIndex).
        func Create(
            assemblyIdentities ImmutableArray[string],
            typeNamesByAssembly ImmutableArray[ImmutableArray[string]]
        ) ReferenceMetadataIndex -> Create(assemblyIdentities, typeNamesByAssembly, default(ImmutableArray[string]))

        /// Creates an index with content fingerprints. Unverified entries cannot be adopted by a resolver.
        /// @param assemblyIdentities Assembly full names in search order.
        /// @param typeNamesByAssembly Type full-names per assembly.
        /// @param contentFingerprints Content fingerprints in search order, or default for unverified entries.
        /// @returns A new metadata index.
        func Create(
            assemblyIdentities ImmutableArray[string],
            typeNamesByAssembly ImmutableArray[ImmutableArray[string]],
            contentFingerprints ImmutableArray[string]
        ) ReferenceMetadataIndex {
            if assemblyIdentities.Length != typeNamesByAssembly.Length {
                throw ArgumentException(
                    "Assembly identity and type-name arrays must have the same length.",
                    "typeNamesByAssembly"
                )
            }
            let fingerprints = if contentFingerprints.IsDefault {
                Enumerable.Repeat(string.Empty, assemblyIdentities.Length).ToImmutableArray()
            } else {
                contentFingerprints
            }
            if fingerprints.Length != assemblyIdentities.Length {
                throw ArgumentException("Content fingerprints must match the assembly count.", "contentFingerprints")
            }
            return ReferenceMetadataIndex(assemblyIdentities, typeNamesByAssembly, fingerprints)
        }

        /// Attempts to parse the (cref:SectionHeader) section out of a
        /// descriptor's full set of [`lines`](paramref) (the section is located
        /// by its header and read to end-of-file). This never throws: any structural
        /// problem (missing header, bad format version, a malformed or out-of-bounds
        /// count, truncation) is reported by returning `false` so the
        /// caller falls back to a cold rebuild. Under-trusting a payload is always
        /// safe; mis-reading one would be a correctness bug.
        /// @param lines All descriptor lines, in order.
        /// @param index The parsed index on success; otherwise `null`.
        /// @returns `true` when a well-formed section was read.
        func TryReadTextSection(lines IReadOnlyList[string]?, out index ReferenceMetadataIndex?) bool {
            index = nil
            if lines == nil {
                return false
            }
            var cursor = -1
            for var i = 0; i < lines.Count; i++ {
                if string.Equals(lines[i]?.Trim(), SectionHeader, StringComparison.Ordinal) {
                    cursor = i + 1
                    break
                }
            }
            if cursor < 0 {
                return false
            }
            try {
                if !TryReadIntField(lines, &cursor, "formatVersion", out var formatVersion) ||
                    formatVersion != FormatVersion {
                    return false
                }
                if !TryReadIntField(lines, &cursor, "assemblyCount", out var assemblyCount) ||
                    assemblyCount < 0 ||
                    assemblyCount > MaxAssemblies {
                    return false
                }
                let identities = ImmutableArray.CreateBuilder[string](assemblyCount)
                let names = ImmutableArray.CreateBuilder[ImmutableArray[string]](assemblyCount)
                let fingerprints = ImmutableArray.CreateBuilder[string](assemblyCount)
                for var a = 0; a < assemblyCount; a++ {
                    if !TryReadStringField(lines, &cursor, "assembly", out var identity) {
                        return false
                    }
                    if identity == nil {
                        return false
                    }
                    if !TryReadStringField(lines, &cursor, "contentFingerprint", out var fingerprint) ||
                        fingerprint == nil {
                        return false
                    }
                    if !TryReadIntField(lines, &cursor, "typeNameCount", out var nameCount) ||
                        nameCount < 0 ||
                        nameCount > MaxTypeNamesPerAssembly {
                        return false
                    }
                    let perAssembly = ImmutableArray.CreateBuilder[string](nameCount)
                    for var n = 0; n < nameCount; n++ {
                        if cursor >= lines.Count {
                            return false
                        }
                        perAssembly.Add(lines[cursor] ?? string.Empty)
                        cursor++
                    }
                    identities.Add(identity)
                    fingerprints.Add(fingerprint)
                    names.Add(perAssembly.MoveToImmutable())
                }
                index = ReferenceMetadataIndex(
                    identities.MoveToImmutable(),
                    names.MoveToImmutable(),
                    fingerprints.MoveToImmutable()
                )
                return true
            } catch (OutOfMemoryException) {
                // A corrupt count could request an absurd allocation; the bounds
                // checks above guard the common cases, this is the backstop.
                return false
            }
        }

        // Advances past blank/comment lines and reads the next `key=value` line,
        // verifying the key matches and the value parses as an int. Used for the
        // structural header/count lines only (never for the verbatim type-name
        // lines, which are read positionally by count).
        private func TryReadIntField(lines IReadOnlyList[string], ref cursor int32, key string, out value int32) bool {
            value = 0
            if !TryReadStringField(lines, &cursor, key, out var raw) {
                return false
            }
            return int32.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)
        }

        // Skips blank and `#` comment lines, then requires the next line to be
        // `<key>=<value>`; returns the value. A non-matching key or end-of-input
        // returns false (a conservative parse failure).
        private func TryReadStringField(
            lines IReadOnlyList[string],
            ref cursor int32,
            key string,
            out value string?
        ) bool {
            value = nil
            while cursor < lines.Count {
                let line string? = lines[cursor]
                let trimmed = line?.Trim()
                if string.IsNullOrEmpty(trimmed) || trimmed!![0] == '#' {
                    cursor++
                    continue
                }
                if line == nil {
                    cursor++
                    continue
                }
                let eq = line.IndexOf('=')
                if eq <= 0 || !string.Equals(line.Substring(0, eq), key, StringComparison.Ordinal) {
                    return false
                }
                value = line.Substring(eq + 1)
                cursor++
                return true
            }
            return false
        }
    }
}
