// <copyright file="MetadataTableDigest.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text

/// Issue #4665: a per-table summary of an emitted assembly, so that when the
/// sample IL hash changes the failure says WHICH part changed. This is a
/// triage hint, not a classification: a change confined to
/// `AssemblyRef`/`TypeRef`/`MemberRef` with identical
/// `MethodBodies` is LIKELY a reference-set difference, but a metadata-only
/// emitter change can retarget those rows too, so inspect the changed rows.
/// A hash change that moves no tracked table means this digest has a gap.
internal shared class MetadataTableDigest {
    internal const AssemblyRef string = "AssemblyRef"
    internal const MethodBodies string = "MethodBodies"

    /// Summarises the metadata tables and method bodies of a PE image.
    /// @param peBytes The emitted assembly.
    /// @returns Table name to summary lines. `AssemblyRef` is listed in full; the rest as a row count and
    /// digest.
    internal func Compute(peBytes[]uint8) SortedDictionary[string, []string] {
        using let pe = PEReader(MemoryStream(peBytes, writable: false))
        let md = pe.GetMetadataReader()
        let tables = SortedDictionary[string, []string](StringComparer.Ordinal)
        tables[AssemblyRef] = md
            .AssemblyReferences
            .Select((h AssemblyReferenceHandle) -> md.GetAssemblyReference(h))
            .Select(
            (a AssemblyReference) -> (
                "${md.GetString(a.Name)}, ${a.Version}, ${Hex(md.GetBlobBytes(a.PublicKeyOrToken))}, flags=${int32(a.Flags)}, " +
                    "culture=${(if a.Culture.IsNil { string.Empty } else { md.GetString(a.Culture) })}, hash=${Hex(md.GetBlobBytes(a.HashValue))}"
            )
        )
            .ToArray()
        tables["TypeRef"] = Summarise(
            md.TypeReferences.Select(
                (h TypeReferenceHandle) -> {
                    let t = md.GetTypeReference(h)
                    return "${ScopeName(md, t.ResolutionScope)}#${MetadataTableDigest.Token(t.ResolutionScope)}|${md.GetString(t.Namespace)}.${md.GetString(t.Name)}"
                }
            )
        )
        // Every row column is part of the digest, with handles as tokens, so a
        // change of base type, parent or member ownership moves the table.
        tables["TypeDef"] = Summarise(
            md.TypeDefinitions.Select(
                (h TypeDefinitionHandle) -> {
                    let t = md.GetTypeDefinition(h)
                    return "${md.GetString(t.Namespace)}.${md.GetString(t.Name)}|${int32(t.Attributes)}|base=${MetadataTableDigest.Token(t.BaseType)}" +
                        "|fields=${string.Join(",", t.GetFields().Select((x FieldDefinitionHandle) -> MetadataTableDigest.Token(x)))}" +
                        "|methods=${string.Join(",", t.GetMethods().Select((x MethodDefinitionHandle) -> MetadataTableDigest.Token(x)))}" +
                        "|layout=${t.GetLayout().Size}/${t.GetLayout().PackingSize}|decl=${MetadataTableDigest.Token(t.GetDeclaringType())}"
                }
            )
        )
        tables["MemberRef"] = Summarise(
            md.MemberReferences.Select(
                (h MemberReferenceHandle) -> {
                    let m = md.GetMemberReference(h)
                    return "parent=${MetadataTableDigest.Token(m.Parent)}|${md.GetString(m.Name)}|${Hex(md.GetBlobBytes(m.Signature))}"
                }
            )
        )
        tables["MethodDef"] = Summarise(
            md.MethodDefinitions.Select(
                (h MethodDefinitionHandle) -> {
                    let m = md.GetMethodDefinition(h)
                    return "${md.GetString(m.Name)}|${int32(m.Attributes)}|${int32(m.ImplAttributes)}|${Hex(md.GetBlobBytes(m.Signature))}" +
                        "|params=${string.Join(",", m.GetParameters().Select((x ParameterHandle) -> MetadataTableDigest.Token(x)))}" +
                        "|generics=${string.Join(",", m.GetGenericParameters().Select((x GenericParameterHandle) -> MetadataTableDigest.Token(x)))}|decl=${MetadataTableDigest.Token(m.GetDeclaringType())}" +
                        "|body=${(if m.RelativeVirtualAddress == 0 { "none" } else { "il" })}"
                }
            )
        )
        tables["FieldDef"] = Summarise(
            md.FieldDefinitions.Select(
                (h FieldDefinitionHandle) -> {
                    let f = md.GetFieldDefinition(h)
                    return "${md.GetString(f.Name)}|${int32(f.Attributes)}|${Hex(md.GetBlobBytes(f.Signature))}|decl=${MetadataTableDigest.Token(f.GetDeclaringType())}"
                }
            )
        )
        // The whole body: header (max stack, init-locals, local signature and
        // its blob) and exception regions as well as the IL.
        tables[MethodBodies] = Summarise(
            md.MethodDefinitions.Select(
                (h MethodDefinitionHandle) -> {
                    let rva = md.GetMethodDefinition(h).RelativeVirtualAddress
                    if rva == 0 {
                        return string.Empty
                    }
                    let body = pe.GetMethodBody(rva)
                    let locals = if body.LocalSignature.IsNil {
                        "none"
                    } else {
                        MetadataTableDigest.Token(body.LocalSignature) +
                            ":" +
                            Hex(md.GetBlobBytes(md.GetStandaloneSignature(body.LocalSignature).Signature))
                    }
                    let regions = string.Join(
                        ";",
                        body.ExceptionRegions.Select(
                            (
                                r ExceptionRegion
                            ) -> "${r.Kind}:${r.TryOffset}+${r.TryLength}:${r.HandlerOffset}+${r.HandlerLength}:${MetadataTableDigest.Token(r.CatchType)}:${r.FilterOffset}"
                        )
                    )
                    return "max=${body.MaxStack}|init=${body.LocalVariablesInitialized}|locals=$locals|eh=$regions" +
                        "|il=${Hex(body.GetILBytes() ?? Array.Empty[uint8]())}"
                }
            )
        )
        return tables
    }

    /// Describes which tables differ between two digests.
    /// @param expected The committed digest.
    /// @param actual The digest of what the compiler emitted now.
    /// @returns One line per differing table, empty when the digests are equal.
    internal func Diff(
        expected IReadOnlyDictionary[string, []string],
        actual IReadOnlyDictionary[string, []string]
    ) IReadOnlyList[string] {
        let lines = List[string]()
        for table in expected.Keys.Union(actual.Keys).OrderBy((k string) -> k, StringComparer.Ordinal) {
            let e = if expected.TryGetValue(table, out var ev) {
                ev
            } else {
                Array.Empty[string]()
            }
            let a = if actual.TryGetValue(table, out var av) {
                av
            } else {
                Array.Empty[string]()
            }
            if e.SequenceEqual(a, StringComparer.Ordinal) {
                continue
            }
            let removed = e.Except(a, StringComparer.Ordinal).ToArray()
            let added = a.Except(e, StringComparer.Ordinal).ToArray()
            lines.Add("$table: -[${string.Join("; ", removed)}] +[${string.Join("; ", added)}]")
        }
        return lines
    }

    private func Summarise(rows IEnumerable[string])[]string {
        let all = rows.ToArray()
        let hash = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", all)))
        return []string{"rows=${all.Length} sha256=${Convert.ToHexString(hash, 0, 8)}"}
    }

    private func ScopeName(md MetadataReader, $scope EntityHandle) string -> switch $scope.Kind {
        case HandleKind.AssemblyReference: md.GetString(md.GetAssemblyReference(AssemblyReferenceHandle($scope)).Name)
        case HandleKind.TypeReference: "nested:" + md.GetString(md.GetTypeReference(TypeReferenceHandle($scope)).Name)
        case HandleKind.ModuleReference: "module"
        default: $scope.Kind.ToString()
    }

    private func Token(handle EntityHandle) string -> if handle.IsNil {
        "nil"
    } else {
        MetadataTokens.GetToken(handle).ToString("X8")
    }

    private func Hex(bytes[]uint8) string -> Convert.ToHexString(bytes)
}
