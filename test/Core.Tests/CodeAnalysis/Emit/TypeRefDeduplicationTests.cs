// <copyright file="TypeRefDeduplicationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 (P3-9): the TypeRef cache previously keyed on reference
/// equality, so the same logical CLR type reached through different
/// <c>MetadataLoadContext</c> paths produced duplicate <c>TypeRef</c> rows.
/// These tests pin the new structural-identity behaviour both at the
/// comparer level and end-to-end against the emitted PE metadata.
/// </summary>
public class TypeRefDeduplicationTests
{
    [Fact]
    public void TypeIdentityComparer_TreatsSameRuntimeTypeAsEqual()
    {
        // Reference-equal types are trivially equal; this is just a baseline
        // sanity check guarding the fast path.
        Assert.True(TypeIdentityComparer.Instance.Equals(typeof(int), typeof(int)));
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(typeof(int)),
            TypeIdentityComparer.Instance.GetHashCode(typeof(int)));
    }

    [Fact]
    public void TypeIdentityComparer_TreatsDifferentTypesAsDistinct()
    {
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(int), typeof(long)));
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(string), typeof(object)));
    }

    [Fact]
    public void TypeIdentityComparer_TreatsTypesFromDistinctLoadContextsAsEqual()
    {
        // Simulate the real bug: load the same assembly twice through two
        // distinct MetadataLoadContext instances. Reflection returns two
        // different Type instances for the same logical type, but they share
        // an assembly-qualified name and so must compare equal.
        var coreAssemblies = System.IO.Directory
            .GetFiles(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
            .ToList();

        using var ctxA = new System.Reflection.MetadataLoadContext(new PathAssemblyResolver(coreAssemblies));
        using var ctxB = new System.Reflection.MetadataLoadContext(new PathAssemblyResolver(coreAssemblies));

        var objectFromA = ctxA.CoreAssembly!.GetType("System.Object");
        var objectFromB = ctxB.CoreAssembly!.GetType("System.Object");

        Assert.NotNull(objectFromA);
        Assert.NotNull(objectFromB);
        Assert.NotSame(objectFromA, objectFromB);
        Assert.True(
            TypeIdentityComparer.Instance.Equals(objectFromA, objectFromB),
            "Same logical type from two MetadataLoadContext instances should be equal.");
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(objectFromA!),
            TypeIdentityComparer.Instance.GetHashCode(objectFromB!));
    }

    [Fact]
    public void TypeIdentityComparer_NullHandling()
    {
        Assert.True(TypeIdentityComparer.Instance.Equals(null, null));
        Assert.False(TypeIdentityComparer.Instance.Equals(null, typeof(int)));
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(int), null));
    }

    [Fact]
    public void TypeIdentityComparer_BackingDictionary_DeduplicatesAcrossLoadContexts()
    {
        var coreAssemblies = System.IO.Directory
            .GetFiles(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
            .ToList();

        using var ctxA = new System.Reflection.MetadataLoadContext(new PathAssemblyResolver(coreAssemblies));
        using var ctxB = new System.Reflection.MetadataLoadContext(new PathAssemblyResolver(coreAssemblies));

        var dict = new Dictionary<Type, int>(TypeIdentityComparer.Instance);
        dict[ctxA.CoreAssembly!.GetType("System.Object")!] = 1;
        dict[ctxB.CoreAssembly!.GetType("System.Object")!] = 2;
        dict[ctxA.CoreAssembly!.GetType("System.String")!] = 3;

        Assert.Equal(2, dict.Count);
        Assert.Equal(2, dict[ctxA.CoreAssembly!.GetType("System.Object")!]);
    }

    [Fact]
    public void EmittedAssembly_HasNoDuplicateTypeRefRows()
    {
        // End-to-end check: compile a small program that exercises several
        // BCL types (Console, String, Int32) and verify the TypeRef table in
        // the emitted PE contains no duplicate (resolutionScope, namespace,
        // name) triples. Prior to the fix the same logical BCL type could
        // appear multiple times.
        const string source = @"
package TypeRefDedupTest
import System

func main() {
    Console.WriteLine(""hello"")
    Console.WriteLine(42)
    Console.WriteLine(""world"")
    Console.WriteLine(1 + 2)
}
";

        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var reader = peReader.GetMetadataReader();

        var seen = new HashSet<(int Scope, string Namespace, string Name)>();
        var duplicates = new List<(int Scope, string Namespace, string Name)>();

        foreach (var handle in reader.TypeReferences)
        {
            var typeRef = reader.GetTypeReference(handle);
            var key = (
                Scope: MetadataTokens.GetToken(typeRef.ResolutionScope),
                Namespace: reader.GetString(typeRef.Namespace),
                Name: reader.GetString(typeRef.Name));
            if (!seen.Add(key))
            {
                duplicates.Add(key);
            }
        }

        Assert.True(
            duplicates.Count == 0,
            "TypeRef table contains duplicate rows: "
                + string.Join(", ", duplicates.Select(d => $"{d.Namespace}.{d.Name}@0x{d.Scope:X8}")));
    }
}
