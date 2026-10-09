// <copyright file="MetadataTableDigest.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4665: a per-table summary of an emitted assembly, so that when the
/// sample IL hash changes the failure says WHICH part changed. A change
/// confined to <c>AssemblyRef</c>/<c>TypeRef</c>/<c>MemberRef</c> with
/// identical <c>MethodBodies</c> is a reference-set difference; a change in
/// <c>MethodBodies</c> is codegen.
/// </summary>
internal static class MetadataTableDigest
{
    internal const string AssemblyRef = "AssemblyRef";

    internal const string MethodBodies = "MethodBodies";

    /// <summary>Summarises the metadata tables and method bodies of a PE image.</summary>
    /// <param name="peBytes">The emitted assembly.</param>
    /// <returns>Table name to summary lines. <c>AssemblyRef</c> is listed in full; the rest as a row count and digest.</returns>
    internal static SortedDictionary<string, string[]> Compute(byte[] peBytes)
    {
        using var pe = new PEReader(new System.IO.MemoryStream(peBytes, writable: false));
        MetadataReader md = pe.GetMetadataReader();
        var tables = new SortedDictionary<string, string[]>(StringComparer.Ordinal);

        tables[AssemblyRef] = md.AssemblyReferences
            .Select(h => md.GetAssemblyReference(h))
            .Select(a => $"{md.GetString(a.Name)}, {a.Version}, {Hex(md.GetBlobBytes(a.PublicKeyOrToken))}")
            .ToArray();

        tables["TypeRef"] = Summarise(md.TypeReferences.Select(h =>
        {
            TypeReference t = md.GetTypeReference(h);
            return $"{ScopeName(md, t.ResolutionScope)}|{md.GetString(t.Namespace)}.{md.GetString(t.Name)}";
        }));

        // Every row column is part of the digest, with handles as tokens, so a
        // change of base type, parent or member ownership moves the table.
        tables["TypeDef"] = Summarise(md.TypeDefinitions.Select(h =>
        {
            TypeDefinition t = md.GetTypeDefinition(h);
            return $"{md.GetString(t.Namespace)}.{md.GetString(t.Name)}|{(int)t.Attributes}|base={Token(t.BaseType)}"
                + $"|fields={string.Join(",", t.GetFields().Select(x => Token(x)))}"
                + $"|methods={string.Join(",", t.GetMethods().Select(x => Token(x)))}"
                + $"|layout={t.GetLayout().Size}/{t.GetLayout().PackingSize}|decl={Token(t.GetDeclaringType())}";
        }));

        tables["MemberRef"] = Summarise(md.MemberReferences.Select(h =>
        {
            MemberReference m = md.GetMemberReference(h);
            return $"parent={Token(m.Parent)}|{md.GetString(m.Name)}|{Hex(md.GetBlobBytes(m.Signature))}";
        }));

        tables["MethodDef"] = Summarise(md.MethodDefinitions.Select(h =>
        {
            MethodDefinition m = md.GetMethodDefinition(h);
            return $"{md.GetString(m.Name)}|{(int)m.Attributes}|{(int)m.ImplAttributes}|{Hex(md.GetBlobBytes(m.Signature))}"
                + $"|params={string.Join(",", m.GetParameters().Select(x => Token(x)))}"
                + $"|generics={string.Join(",", m.GetGenericParameters().Select(x => Token(x)))}|decl={Token(m.GetDeclaringType())}"
                + $"|body={(m.RelativeVirtualAddress == 0 ? "none" : "il")}";
        }));

        tables["FieldDef"] = Summarise(md.FieldDefinitions.Select(h =>
        {
            FieldDefinition f = md.GetFieldDefinition(h);
            return $"{md.GetString(f.Name)}|{(int)f.Attributes}|{Hex(md.GetBlobBytes(f.Signature))}|decl={Token(f.GetDeclaringType())}";
        }));

        // The whole body: header (max stack, init-locals, local signature and
        // its blob) and exception regions as well as the IL.
        tables[MethodBodies] = Summarise(md.MethodDefinitions.Select(h =>
        {
            int rva = md.GetMethodDefinition(h).RelativeVirtualAddress;
            if (rva == 0)
            {
                return string.Empty;
            }

            MethodBodyBlock body = pe.GetMethodBody(rva);
            string locals = body.LocalSignature.IsNil
                ? "none"
                : Token(body.LocalSignature) + ":" + Hex(md.GetBlobBytes(md.GetStandaloneSignature(body.LocalSignature).Signature));
            string regions = string.Join(
                ";",
                body.ExceptionRegions.Select(r =>
                    $"{r.Kind}:{r.TryOffset}+{r.TryLength}:{r.HandlerOffset}+{r.HandlerLength}:{Token(r.CatchType)}:{r.FilterOffset}"));
            return $"max={body.MaxStack}|init={body.LocalVariablesInitialized}|locals={locals}|eh={regions}"
                + $"|il={Hex(body.GetILBytes() ?? Array.Empty<byte>())}";
        }));

        return tables;
    }

    /// <summary>Describes which tables differ between two digests.</summary>
    /// <param name="expected">The committed digest.</param>
    /// <param name="actual">The digest of what the compiler emitted now.</param>
    /// <returns>One line per differing table, empty when the digests are equal.</returns>
    internal static IReadOnlyList<string> Diff(
        IReadOnlyDictionary<string, string[]> expected, IReadOnlyDictionary<string, string[]> actual)
    {
        var lines = new List<string>();
        foreach (string table in expected.Keys.Union(actual.Keys).OrderBy(k => k, StringComparer.Ordinal))
        {
            string[] e = expected.TryGetValue(table, out var ev) ? ev : Array.Empty<string>();
            string[] a = actual.TryGetValue(table, out var av) ? av : Array.Empty<string>();
            if (e.SequenceEqual(a, StringComparer.Ordinal))
            {
                continue;
            }

            string[] removed = e.Except(a, StringComparer.Ordinal).ToArray();
            string[] added = a.Except(e, StringComparer.Ordinal).ToArray();
            lines.Add($"{table}: -[{string.Join("; ", removed)}] +[{string.Join("; ", added)}]");
        }

        return lines;
    }

    private static string[] Summarise(IEnumerable<string> rows)
    {
        string[] all = rows.ToArray();
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", all)));
        return new[] { $"rows={all.Length} sha256={Convert.ToHexString(hash, 0, 8)}" };
    }

    private static string ScopeName(MetadataReader md, EntityHandle scope) => scope.Kind switch
    {
        HandleKind.AssemblyReference => md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)scope).Name),
        HandleKind.TypeReference => "nested:" + md.GetString(md.GetTypeReference((TypeReferenceHandle)scope).Name),
        HandleKind.ModuleReference => "module",
        _ => scope.Kind.ToString(),
    };

    private static string Token(EntityHandle handle) => handle.IsNil ? "nil" : MetadataTokens.GetToken(handle).ToString("X8");

    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes);
}
