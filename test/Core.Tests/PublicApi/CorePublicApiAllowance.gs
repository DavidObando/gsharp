// <copyright file="CorePublicApiAllowance.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.PublicApi

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable

/// ADR-0199: the one narrow, exact allow-list of members the Core public-API
/// snapshot tolerates on a G#-built `GSharp.Core.dll` but the native C#
/// build does not have. A body-only C# record has no `Deconstruct`; the
/// same record migrated to a G# `data class` gets G#'s synthesized one
/// (G# keeps its own `Deconstruct` rule, ADR-0199 item 4).
///
/// The allowance is "may be present", never "must": the native build has none
/// of the entries and passes without them. It is not a general additive waiver.
/// An entry is honored only when it is a public `Deconstruct` method on a
/// record type (one with a synthesized `<Clone>$` member). A new
/// synthesized member needs an ADR amendment and its own list entry.
internal shared class CorePublicApiAllowance {
    /// One allow-list entry: a type's full name and one rendered member line.
    internal data struct Entry(TypeName string, MemberLine string) : IEquatable[CorePublicApiAllowance.Entry] { }

    /// The outcome of applying the allow-list to a rendered surface.
    internal class Result {
        init(lines IReadOnlyList[string], present IReadOnlyList[string]) {
            this.Lines = lines
            this.Present = present
        }

        /// Gets the rendered surface with the allowed additions removed.
        prop Lines IReadOnlyList[string] {
            get;
        }

        /// Gets the allowed additions that were present, for the test output.
        prop Present IReadOnlyList[string] {
            get;
        }
    }

    internal const AllowanceFileName string = "gsharp-core-public-api-allowed-additions.txt"
    private const Separator string = " | "
    private const RecordCloneMarker string = " <Clone>$$()"
    private const DeconstructPrefix string = "  method public Void Deconstruct("

    /// Parses the allow-list file: `#` comments and blank lines are
    /// skipped, every other line is `Full.Type.Name | rendered member line`.
    /// @param text The file text.
    /// @returns The entries in file order.
    internal func Parse(text string) IReadOnlyList[CorePublicApiAllowance.Entry] {
        let entries = List[CorePublicApiAllowance.Entry]()
        for raw in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n') {
            if raw.Trim().Length == 0 || raw.TrimStart().StartsWith('#') {
                continue
            }
            let split = raw.IndexOf(Separator, StringComparison.Ordinal)
            if split <= 0 {
                throw InvalidOperationException("Malformed allowed-additions line (want 'Type | member'): $raw")
            }
            entries.Add(
                CorePublicApiAllowance.Entry(raw[.. split].Trim(), "  " + raw[(split + Separator.Length) ..].Trim())
            )
        }
        return entries
    }

    /// Removes the allowed additions from [`rendered`](paramref) so the
    /// remainder can be compared with the native snapshot. Throws when an
    /// entry is not a record `Deconstruct`, or names a type that is not a
    /// record in the rendered surface.
    /// @param rendered The rendered public API lines.
    /// @param allowance The allow-list entries.
    /// @param builtByGsc Whether the rendered assembly was produced by gsc. The waiver covers
    /// G#-synthesized members only, so for any other assembly (the native C#
    /// build) nothing is removed and an authored matching member still fails.
    /// @returns The remaining lines and the allowed additions that were present.
    internal func Apply(
        rendered IReadOnlyList[string],
        allowance IReadOnlyList[CorePublicApiAllowance.Entry],
        builtByGsc bool = true
    ) Result {
        if !builtByGsc {
            return Result(rendered.ToList(), List[string]())
        }
        let drop = HashSet[int32]()
        let present = List[string]()
        for entry in allowance {
            if !entry.MemberLine.StartsWith(DeconstructPrefix, StringComparison.Ordinal) {
                throw InvalidOperationException(
                    "Allowed addition is not a public Deconstruct method (ADR-0199 allows nothing else): ${entry.TypeName} | ${entry.MemberLine.Trim()}"
                )
            }
            let header = FindType(rendered, entry.TypeName)
            if header < 0 {
                continue
            }
            var end = header + 1
            while end < rendered.Count && !rendered[end].StartsWith("type ", StringComparison.Ordinal) {
                end++
            }
            var isRecord = false
            var match = -1
            for var i = header + 1; i < end; i++ {
                isRecord |= rendered[i].Contains(RecordCloneMarker, StringComparison.Ordinal)
                if string.Equals(rendered[i], entry.MemberLine, StringComparison.Ordinal) {
                    match = i
                }
            }
            if !isRecord {
                throw InvalidOperationException(
                    "Allowed addition names a type that is not a record: ${entry.TypeName} | ${entry.MemberLine.Trim()}"
                )
            }
            if match < 0 {
                continue
            }
            drop.Add(match)
            present.Add("${entry.TypeName} | ${entry.MemberLine.Trim()}")
        }
        let lines = rendered.Where((_ string, index int32) -> !drop.Contains(index)).ToList()
        return Result(lines, present)
    }

    /// Reports whether the assembly was emitted by gsc: gsc stamps every
    /// assembly that declares data types with the `GSharp.TypeSemantics`
    /// assembly-metadata attribute, which the C# compiler never writes.
    /// @param assemblyPath The assembly to inspect.
    /// @returns `true` when the marker is present.
    internal func IsBuiltByGsc(assemblyPath string) bool {
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        for handle in reader.GetAssemblyDefinition().GetCustomAttributes() {
            let attribute = reader.GetCustomAttribute(handle)
            if attribute.Constructor.Kind != HandleKind.MemberReference {
                continue
            }
            let parent = reader.GetMemberReference(MemberReferenceHandle(attribute.Constructor)).Parent
            if parent.Kind != HandleKind.TypeReference {
                continue
            }
            let type = reader.GetTypeReference(TypeReferenceHandle(parent))
            if reader.GetString(type.Name) != "AssemblyMetadataAttribute" || reader.GetString(
                type.Namespace
            ) != "System.Reflection" {
                continue
            }
            // Fixed arguments: the key is the first serialized string after the prolog.
            var blob = reader.GetBlobReader(attribute.Value)
            if blob.ReadUInt16() == uint16(1) && blob.ReadSerializedString() == "GSharp.TypeSemantics" {
                return true
            }
        }
        return false
    }

    private func FindType(rendered IReadOnlyList[string], typeName string) int32 {
        for var i = 0; i < rendered.Count; i++ {
            let line = rendered[i]
            if !line.StartsWith("type ", StringComparison.Ordinal) {
                continue
            }
            let colon = line.IndexOf(" : ", StringComparison.Ordinal)
            let head = if colon < 0 {
                line
            } else {
                line[.. colon]
            }
            if head.EndsWith(" " + typeName, StringComparison.Ordinal) {
                return i
            }
        }
        return -1
    }
}
