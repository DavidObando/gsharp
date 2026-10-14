// <copyright file="TypeRefDeduplicationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// Issue #420 (P3-9): the TypeRef cache previously keyed on reference
/// equality, so the same logical CLR type reached through different
/// `MetadataLoadContext` paths produced duplicate `TypeRef` rows.
/// These tests pin the new structural-identity behaviour both at the
/// comparer level and end-to-end against the emitted PE metadata.
open class TypeRefDeduplicationTests {
    @Fact
    func TypeIdentityComparer_TreatsSameRuntimeTypeAsEqual() {
        // Reference-equal types are trivially equal; this is just a baseline
        // sanity check guarding the fast path.
        Assert.True(TypeIdentityComparer.Instance.Equals(typeof(int32), typeof(int32)))
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(typeof(int32)),
            TypeIdentityComparer.Instance.GetHashCode(typeof(int32))
        )
    }

    @Fact
    func TypeIdentityComparer_TreatsDifferentTypesAsDistinct() {
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(int32), typeof(int64)))
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(string), typeof(object)))
    }

    @Fact
    func TypeIdentityComparer_TreatsTypesFromDistinctLoadContextsAsEqual() {
        // Simulate the real bug: load the same assembly twice through two
        // distinct MetadataLoadContext instances. Reflection returns two
        // different Type instances for the same logical type, but they share
        // an assembly-qualified name and so must compare equal.
        let coreAssemblies = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll").ToList()
        using let ctxA = MetadataLoadContext(PathAssemblyResolver(coreAssemblies))
        using let ctxB = MetadataLoadContext(PathAssemblyResolver(coreAssemblies))
        let objectFromA Type? = ctxA.CoreAssembly!!.GetType("System.Object")
        let objectFromB Type? = ctxB.CoreAssembly!!.GetType("System.Object")
        Assert.NotNull(objectFromA)
        Assert.NotNull(objectFromB)
        Assert.NotSame(objectFromA, objectFromB)
        Assert.True(
            TypeIdentityComparer.Instance.Equals(objectFromA, objectFromB),
            "Same logical type from two MetadataLoadContext instances should be equal."
        )
        Assert.Equal(
            TypeIdentityComparer.Instance.GetHashCode(objectFromA!!),
            TypeIdentityComparer.Instance.GetHashCode(objectFromB!!)
        )
    }

    @Fact
    func TypeIdentityComparer_NullHandling() {
        Assert.True(TypeIdentityComparer.Instance.Equals(nil, nil))
        Assert.False(TypeIdentityComparer.Instance.Equals(nil, typeof(int32)))
        Assert.False(TypeIdentityComparer.Instance.Equals(typeof(int32), nil))
    }

    @Fact
    func TypeIdentityComparer_BackingDictionary_DeduplicatesAcrossLoadContexts() {
        let coreAssemblies = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll").ToList()
        using let ctxA = MetadataLoadContext(PathAssemblyResolver(coreAssemblies))
        using let ctxB = MetadataLoadContext(PathAssemblyResolver(coreAssemblies))
        let dict = Dictionary[Type, int32](TypeIdentityComparer.Instance)
        dict[ctxA.CoreAssembly!!.GetType("System.Object")!!] = 1
        dict[ctxB.CoreAssembly!!.GetType("System.Object")!!] = 2
        dict[ctxA.CoreAssembly!!.GetType("System.String")!!] = 3
        Assert.Equal(2, dict.Count)
        Assert.Equal(2, dict[ctxA.CoreAssembly!!.GetType("System.Object")!!])
    }

    @Fact
    func EmittedAssembly_HasNoDuplicateTypeRefRows() {
        // End-to-end check: compile a small program that exercises several
        // BCL types (Console, String, Int32) and verify the TypeRef table in
        // the emitted PE contains no duplicate (resolutionScope, namespace,
        // name) triples. Prior to the fix the same logical BCL type could
        // appear multiple times.
        const source = `
package TypeRefDedupTest
import System

func main() {
    Console.WriteLine("hello")
    Console.WriteLine(42)
    Console.WriteLine("world")
    Console.WriteLine(1 + 2)
}
`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let reader = peReader.GetMetadataReader()
        let seen = HashSet[(Scope int32, Namespace string, Name string)]()
        let duplicates = List[(Scope int32, Namespace string, Name string)]()
        for handle in reader.TypeReferences {
            let typeRef = reader.GetTypeReference(handle)
            let key = (
                Scope: MetadataTokens.GetToken(typeRef.ResolutionScope),
                Namespace: reader.GetString(typeRef.Namespace),
                Name: reader.GetString(typeRef.Name)
            )
            if !seen.Add(key) {
                duplicates.Add(key)
            }
        }
        Assert.True(
            duplicates.Count == 0,
            "TypeRef table contains duplicate rows: " + string.Join(
                ", ",
                duplicates.Select(
                    (d(Scope int32, Namespace string, Name string)) -> "${d.Namespace}.${d.Name}@0x${d.Scope:X8}"
                )
            )
        )
    }
}
