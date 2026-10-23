// <copyright file="Issue5124TypeNameIndexTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import Xunit

/// Issue #5124: the reference type-name index is read from the metadata tables
/// instead of materializing every type with `GetTypes()`. These tests pin that the
/// names, their order and the type each name resolves to are the ones reflection
/// reports.
open class Issue5124TypeNameIndexTests {
    @Fact
    func IndexedNames_Equal_ReflectionNames_InOrder_ForEveryReferenceAssembly() {
        using let resolver = ReferenceResolver.WithReferences([]string{typeof(ReferenceResolver).Assembly.Location})
        let index = resolver.ExportMetadataIndex()
        Assert.Equal(resolver.Assemblies.Length, index.TypeNames.Length)
        var checkedForwarders = 0
        for var i = 0; i < resolver.Assemblies.Length; i++ {
            // Exact order, no sorting: the first assembly to declare a name owns it.
            let expectedNames = ReflectionNames(resolver.Assemblies[i])
            let extra = string.Join(";", index.TypeNames[i].Except(expectedNames).Take(5))
            let missing = string.Join(";", expectedNames.Except(index.TypeNames[i]).Take(5))
            var firstDifference = 0
            while firstDifference < expectedNames.Count &&
                firstDifference < index
                .TypeNames[i]
                .Length &&
                expectedNames[firstDifference] == index.TypeNames[i][firstDifference] {
                firstDifference++
            }
            let around = if firstDifference < expectedNames.Count && firstDifference < index.TypeNames[i].Length {
                "at ${firstDifference}: expected " + string.Join(
                    " | ",
                    expectedNames.Skip(firstDifference - 4).Take(14)
                ) +
                    " ACTUAL " +
                    string.Join(" | ", index.TypeNames[i].Skip(firstDifference - 4).Take(14))
            } else {
                "counts ${expectedNames.Count} ${index.TypeNames[i].Length}"
            }
            Assert.True(
                expectedNames.SequenceEqual(index.TypeNames[i]),
                "${resolver.Assemblies[i].GetName().Name}: extra=[${extra}] missing=[${missing}] ${around}"
            )
            checkedForwarders += ForwardedTypes(resolver.Assemblies[i]).Count((t Type?) -> t != nil)
        }
        Assert.True(resolver.Assemblies.Length > 50, "expected the BCL closure")
        Assert.True(checkedForwarders > 0, "the closure must include type forwarders")
    }

    @Fact
    func IndexedNames_Resolve_ToTheTypeReflectionFindsFirst() {
        using let resolver = ReferenceResolver.WithReferences([]string{typeof(ReferenceResolver).Assembly.Location})
        // First writer wins across assemblies, exactly as the reflection scan did.
        let expected = Dictionary[string, Type](StringComparer.Ordinal)
        for assembly in resolver.Assemblies {
            for name in ReflectionNames(assembly) {
                if !expected.ContainsKey(name) {
                    expected[name] = assembly.GetType(name)!!
                }
            }
        }
        var resolved = 0
        for (name, type) in expected {
            if !type.IsVisible {
                continue
            }
            Assert.True(resolver.TryResolveType(name, out var found), name)
            Assert.Equal(type.FullName, found.FullName)
            Assert.Equal(type.Assembly.GetName().FullName, found.Assembly.GetName().FullName)
            resolved++
        }
        Assert.True(resolved > 1000)
    }

    @Fact
    func NestedAndGenericNames_UseReflectionSpelling() {
        using let fixture = CSharpFixture(
            "namespace N5124 { public class Outer { public class Inner { public class Deep {} } } public class G<T, U> {} } public class GlobalType5124 {}"
        )
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        Assert.True(resolver.TryResolveType("N5124.Outer+Inner+Deep", out var deep))
        Assert.Equal("N5124.Outer+Inner+Deep", deep.FullName)
        Assert.True(resolver.TryResolveType("N5124.G`2", out var generic))
        Assert.Equal("N5124.G`2", generic.FullName)
        Assert.True(resolver.TryResolveType("GlobalType5124", out _))
        Assert.False(resolver.TryResolveType("N5124.Inner", out _))
    }

    @Fact
    func ReorderedReferences_RejectAnIndexExportedForTheOriginalOrder() {
        using let first = CSharpFixture("public class Shared5124 { public int FromFirst; }", assemblyName: "OrderA5124")
        using let second = CSharpFixture(
            "public class Shared5124 { public int FromSecond; }",
            assemblyName: "OrderB5124"
        )
        using let producer = ReferenceResolver.WithReferences([]string{first.AssemblyPath, second.AssemblyPath})
        using let reordered = ReferenceResolver.WithReferences([]string{second.AssemblyPath, first.AssemblyPath})
        let index = producer.ExportMetadataIndex()
        // The recorded identities are in search order, so the other order is a different index.
        Assert.False(reordered.TryUseMetadataIndex(index))
        Assert.True(producer.TryResolveType("Shared5124", out var fromProducer))
        Assert.Equal("OrderA5124", fromProducer.Assembly.GetName().Name)
        Assert.True(reordered.TryResolveType("Shared5124", out var fromReordered))
        Assert.Equal("OrderB5124", fromReordered.Assembly.GetName().Name)
    }

    @Fact
    func NamesNeedingReflectionEscaping_AreLeftToReflection() {
        let builder = PersistedAssemblyBuilder(AssemblyName("Escaping5124"), typeof(object).Assembly)
        let module_ = builder.DefineDynamicModule("Escaping5124")
        module_.DefineType("Plain5124", TypeAttributes.Public | TypeAttributes.Class).CreateType()
        module_.DefineType("Odd5124[Name", TypeAttributes.Public | TypeAttributes.Class).CreateType()
        using let stream = MemoryStream()
        builder.Save(stream)
        let defined = List[string]()
        let forwarded = List[KeyValuePair[string, string]]()
        let publicNested = Dictionary[string, List[string]]()
        Assert.False(MetadataTypeNameReader.TryReadNames(stream.ToArray(), defined, forwarded, publicNested))
    }

    @Fact
    func ForwardToAnAssemblyReadThroughReflection_FollowsTheSameNestedTypes() {
        // The target is read from metadata in one run and through reflection in the
        // other, because only the second one has a name that reflection escapes.
        // Both runs must produce the same names and the same first declarer.
        let metadata = ForwardingIndex(withEscapedName: false)
        let reflection = ForwardingIndex(withEscapedName: true)
        Assert.Equal(metadata.FacadeNames, reflection.FacadeNames)
        Assert.Contains("N5124.Outer+Inner", reflection.FacadeNames)
        Assert.Equal("Target5124", metadata.InnerAssembly)
        Assert.Equal("Target5124", reflection.InnerAssembly)
    }

    shared {
        // References are ordered [facade, rival, target]. The rival also declares
        // N5124.Outer+Inner, so the facade must contribute that name for the target.
        private func ForwardingIndex(withEscapedName bool) ForwardingResult5124 {
            let directory = Path.Combine(AppContext.BaseDirectory, "csharp-fixtures", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let targetPath = Path.Combine(directory, "Target5124.dll")
            let builder = PersistedAssemblyBuilder(AssemblyName("Target5124"), typeof(object).Assembly)
            let module_ = builder.DefineDynamicModule("Target5124")
            let outer = module_.DefineType("N5124.Outer", TypeAttributes.Public | TypeAttributes.Class)
            let inner = outer.DefineNestedType("Inner", TypeAttributes.NestedPublic | TypeAttributes.Class)
            outer.CreateType()
            inner.CreateType()
            if withEscapedName {
                module_.DefineType("Odd5124[Name", TypeAttributes.Public | TypeAttributes.Class).CreateType()
            }
            builder.Save(targetPath)
            using let facade = CSharpFixture(
                "[assembly: System.Runtime.CompilerServices.TypeForwardedTo(typeof(N5124.Outer))]",
                []MetadataReference{MetadataReference.CreateFromFile(targetPath)},
                assemblyName: "Facade5124"
            )
            using let rival = CSharpFixture(
                "namespace N5124 { public class Outer { public class Inner {} } }",
                assemblyName: "Rival5124"
            )
            using let resolver = ReferenceResolver.WithReferences(
                []string{facade.AssemblyPath, rival.AssemblyPath, targetPath}
            )
            let facadeIndex = Array.FindIndex(
                resolver.Assemblies.ToArray(),
                (a Assembly) -> a.GetName().Name == "Facade5124"
            )
            Assert.Equal(0, facadeIndex)
            let names = resolver.ExportMetadataIndex().TypeNames[facadeIndex].ToList()
            Assert.True(resolver.TryResolveType("N5124.Outer+Inner", out var found))
            return ForwardingResult5124(names, found.Assembly.GetName().Name!!)
        }

        private func ForwardedTypes(assembly Assembly)[]Type? {
            try {
                return assembly.GetForwardedTypes()
            } catch (ex ReflectionTypeLoadException) {
                return ex.Types
            }
        }

        private func ReflectionNames(assembly Assembly) List[string] {
            var defined[]Type?
            try {
                defined = assembly.GetTypes()
            } catch (ex ReflectionTypeLoadException) {
                defined = ex.Types
            }
            let names = List[string]()
            for t in defined {
                if t?.FullName is {} name {
                    names.Add(name)
                }
            }
            for t in ForwardedTypes(assembly) {
                if t?.FullName is {} name {
                    names.Add(name)
                }
            }
            return names
        }
    }
}

internal class ForwardingResult5124 {
    internal init(facadeNames List[string], innerAssembly string) {
        FacadeNames = facadeNames
        InnerAssembly = innerAssembly
    }

    internal prop FacadeNames List[string]

    internal prop InnerAssembly string
}
