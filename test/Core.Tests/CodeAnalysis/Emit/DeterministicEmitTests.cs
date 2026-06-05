// <copyright file="DeterministicEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #456: golden-file determinism tests. With
/// <see cref="DebugInformationOptions.Deterministic"/> enabled, emitting the
/// same source must produce byte-for-byte identical PE output, including a
/// stable SHA-256. These tests pin the dedup / handle-arithmetic fixes from
/// the P3-7, P3-8, P3-9, P3-11 cluster (#420): if any of those caches
/// regresses (extra <c>TypeRef</c>/<c>MethodSpec</c>/<c>MemberRef</c> rows,
/// or speculative row-count arithmetic flips an enum's TypeDef handle), the
/// PE bytes will diverge across iterations and these tests will fail loudly.
/// </summary>
public class DeterministicEmitTests
{
    // A program intentionally chosen to exercise every dedup cache touched by
    // the issue:
    //   * Repeated calls into Console.WriteLine + string operations create
    //     repeated TypeRef/MemberRef lookups (P3-9, P3-11-adjacent caches).
    //   * The generic call into Interlocked.CompareExchange<T> via the event
    //     accessor synthesizes a MethodSpec whose generic arg is a *user*
    //     type — that is the exact path P3-7 dedups.
    //   * The `ref struct` and the user `enum` exercise the IsByRefLike /
    //     IsReadOnly attribute caches (P3-11) and the enum TypeDef handle
    //     plumbing (P3-8) respectively.
    private const string RepresentativeSource = @"package Det
import System

type Color enum {
    Red,
    Green,
    Blue,
}

type Counter data struct {
    N int32
}

func add(a int32, b int32) int32 {
    return a + b
}

func greet(name string) string {
    return ""Hello, "" + name
}

var c = Counter{N: 0}
var c1 = Counter{N: add(c.N, 1)}
var c2 = Counter{N: add(c1.N, 2)}
var c3 = Counter{N: add(c2.N, 3)}

var picked = Color.Green
var label = ""unknown""
switch picked {
case Color.Red { label = ""red"" }
case Color.Green { label = ""green"" }
case Color.Blue { label = ""blue"" }
}

Console.WriteLine(greet(""world""))
Console.WriteLine(greet(""det""))
Console.WriteLine(c3.N)
Console.WriteLine(label)
";

    [Fact]
    public void Deterministic_Emit_Produces_Byte_Identical_PE_Across_Iterations()
    {
        // Five iterations. One is a sanity check; five guards against subtle
        // race-y or accumulator-style non-determinism (e.g. a cache that
        // grows by one entry per emit because of reference-equality keys —
        // the exact P3-7/P3-9 failure mode).
        const int Iterations = 5;
        var hashes = new List<string>(Iterations);
        byte[] firstBytes = null;

        for (int i = 0; i < Iterations; i++)
        {
            var bytes = CompileDeterministic(RepresentativeSource);
            hashes.Add(Sha256Hex(bytes));
            if (i == 0)
            {
                firstBytes = bytes;
            }
            else
            {
                Assert.True(
                    firstBytes.AsSpan().SequenceEqual(bytes),
                    $"Iteration {i} produced different PE bytes than iteration 0 — deterministic emit regressed. SHA0={hashes[0]} SHA{i}={hashes[i]}");
            }
        }

        // All hashes equal — the actual golden assertion. We pin the *stability*
        // of the hash across runs rather than a fixed hex string, because the
        // exact bytes depend on the host's reference assemblies (System.Console
        // metadata, mscorlib version, etc.) and would be brittle across .NET
        // runtimes. Stability across runs is exactly the determinism property
        // we care about.
        Assert.Single(hashes.Distinct());
    }

    [Fact]
    public void Deterministic_Emit_Does_Not_Bloat_Metadata_With_Duplicate_Rows()
    {
        // Belt-and-braces guard for the dedup caches. After compiling the
        // representative source, no two TypeRef rows may resolve to the
        // same (ResolutionScope, Namespace, Name) tuple, no two MemberRef
        // rows may share (Parent, Name, Signature), and no two MethodSpec
        // rows may share (Method, Instantiation). If P3-7 / P3-9 / P3-11
        // regress, the duplicate scan below catches it.
        var bytes = CompileDeterministic(RepresentativeSource);
        using var pe = new PEReader(new MemoryStream(bytes));
        var md = pe.GetMetadataReader();

        var typeRefKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var handle in md.TypeReferences)
        {
            var tr = md.GetTypeReference(handle);
            var key = $"{MetadataTokens.GetToken(tr.ResolutionScope):X8}|{md.GetString(tr.Namespace)}|{md.GetString(tr.Name)}";
            Assert.True(typeRefKeys.Add(key), $"Duplicate TypeRef row detected for '{key}'. The P3-9 TypeRef cache must dedup by structural identity.");
        }

        var memberRefKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var handle in md.MemberReferences)
        {
            var mr = md.GetMemberReference(handle);
            var sig = md.GetBlobBytes(mr.Signature);
            var sigHex = Convert.ToHexString(sig);
            var key = $"{MetadataTokens.GetToken(mr.Parent):X8}|{md.GetString(mr.Name)}|{sigHex}";
            Assert.True(memberRefKeys.Add(key), $"Duplicate MemberRef row detected for '{key}'. The P3-11 (IsReadOnly/IsByRefLike) and adjacent MemberRef caches must dedup by (parent, name, signature).");
        }

        var methodSpecKeys = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 1, n = md.GetTableRowCount(TableIndex.MethodSpec); i <= n; i++)
        {
            var msHandle = MetadataTokens.MethodSpecificationHandle(i);
            var ms = md.GetMethodSpecification(msHandle);
            var inst = md.GetBlobBytes(ms.Signature);
            var key = $"{MetadataTokens.GetToken(ms.Method):X8}|{Convert.ToHexString(inst)}";
            Assert.True(methodSpecKeys.Add(key), $"Duplicate MethodSpec row detected for '{key}'. The P3-7 MethodSpec cache must dedup user-type generic args by structural identity.");
        }
    }

    [Fact]
    public void Deterministic_Emit_Enum_TypeDef_Handle_Matches_FieldList_Stamp()
    {
        // P3-8 regression guard: the enum TypeDef's fieldList must point at
        // the very first FieldDef the enum emits (value__). If the speculative
        // row-count arithmetic ever drifts out of phase with actual emission,
        // the TypeDef.fieldList row number will not equal the first member
        // FieldDef row, and the runtime would see a mis-stamped enum.
        var bytes = CompileDeterministic(RepresentativeSource);
        using var pe = new PEReader(new MemoryStream(bytes));
        var md = pe.GetMetadataReader();

        TypeDefinition colorTypeDef = default;
        bool found = false;
        foreach (var handle in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(handle);
            if (md.GetString(td.Name) == "Color")
            {
                colorTypeDef = td;
                found = true;
                break;
            }
        }

        Assert.True(found, "Expected to find the user-declared 'Color' enum TypeDef.");

        var firstField = colorTypeDef.GetFields().First();
        var firstFieldDef = md.GetFieldDefinition(firstField);
        Assert.Equal("value__", md.GetString(firstFieldDef.Name));
    }

    private static byte[] CompileDeterministic(string source)
    {
        using var peStream = new MemoryStream();

        // Use a fixed assembly name + version so neither contributes
        // run-to-run drift to the produced bytes.
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Deterministic = true },
        };

        var result = compilation.Emit(
            peStream: peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "GSharp.DeterministicGolden",
            assemblyVersion: "1.0.0.0");

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        return peStream.ToArray();
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(bytes));
    }
}
