// <copyright file="Issue5144MetadataTypeSymbolTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import AssemblyIdentity = GSharp.Core.CodeAnalysis.Symbols.AssemblyIdentity
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import SpecialType = GSharp.Core.CodeAnalysis.Symbols.SpecialType
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Threading.Tasks
import Xunit

/// ADR-0209 PR 2a (#5144): type definitions as handle-backed symbols, compared with the context on names,
/// nesting, arity, generic parameters, kind flags and base definitions (questions Q2 to Q4).
open class Issue5144MetadataTypeSymbolTests {
    @Fact
    func EveryTypeDefinitionOfTheCoreClosure_AgreesWithTheContext() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        let found = MetadataModelComparison
            .Compare(resolver, set)
            .Where((d ModelDisagreement) -> d.Question == "Q2.type-definition")
            .ToList()
        var types = 0
        for var m = 0; m < set.SearchedCount; m++ {
            types += set.Modules[m].DefinedNames.Count
        }
        Assert.True(types > 10000, "expected the BCL closure")
        Assert.True(found.Count == 0, MetadataModelComparison.FormatReport(found))
    }

    @Fact
    func KindsGenericsAndBases_OfAFixture_AreTheExpectedOnes() {
        using let fixture = CSharpFixture(
            "using System; namespace N5144T { public interface IShape<in TIn, out TOut> {} public abstract class Shape {} public sealed class Circle : Shape {} public struct Point {} public enum Color { Red } public delegate void Handler(int x); public class Holder<T> where T : class, new() { public class Inner<U> {} } public class Derived : System.Collections.Generic.List<int> {} }",
            assemblyName: "Kinds5144T"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Kinds5144T")!!
        let shape = Symbol(module, "N5144T.IShape`2")
        Assert.True(shape.Kinds.IsInterface && shape.Kinds.IsAbstract)
        Assert.Equal(2, shape.GenericParameters.Length)
        Assert.Equal(GenericParameterAttributes.Contravariant, shape.GenericParameters[0].Variance)
        Assert.Equal(GenericParameterAttributes.Covariant, shape.GenericParameters[1].Variance)
        Assert.True(Symbol(module, "N5144T.Shape").Kinds.IsAbstract)
        Assert.True(Symbol(module, "N5144T.Circle").Kinds.IsSealed)
        Assert.False(Symbol(module, "N5144T.Circle").Kinds.IsValueType)
        Assert.True(Symbol(module, "N5144T.Point").Kinds.IsValueType)
        let color = Symbol(module, "N5144T.Color")
        Assert.True(color.Kinds.IsEnum && color.Kinds.IsValueType)
        Assert.True(Symbol(module, "N5144T.Handler").Kinds.IsDelegate)
        let holder = Symbol(module, "N5144T.Holder`1")
        Assert.Equal(
            GenericParameterAttributes.ReferenceTypeConstraint | GenericParameterAttributes.DefaultConstructorConstraint,
            holder.GenericParameters[0].Attributes
        )
        let inner = Symbol(module, "N5144T.Holder`1+Inner`1")
        Assert.Same(holder, inner.EnclosingType)
        // A nested type in a generic type repeats the enclosing parameters first, as the table holds them.
        Assert.Equal(2, inner.GenericParameters.Length)
        Assert.Equal("T", inner.GenericParameters[0].Name)
        Assert.Equal("U", inner.GenericParameters[1].Name)
        // A generic base resolves to its definition.
        Assert.Equal("System.Collections.Generic.List`1", Symbol(module, "N5144T.Derived").BaseDefinition!!.FullName)
        Assert.Null(Symbol(module, "N5144T.IShape`2").BaseDefinition)
        Assert.Null(shape.ClrType)
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func ABaseTheSetLacks_IsAMissingType_AndTheContextAgrees() {
        using let lib = CSharpFixture("namespace N5144B { public class Root {} }", assemblyName: "Root5144")
        using let derived = CSharpFixture(
            "public class Leaf5144 : N5144B.Root {}",
            []MetadataReference{MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "Leaf5144"
        )
        using let resolver = HandleResolver([]string{derived.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Leaf5144")!!
        module.TryGetDefinition("Leaf5144", out var handle)
        let leaf = module.GetTypeSymbol(handle)
        let baseDefinition = leaf.BaseDefinition!!
        Assert.False(baseDefinition.IsResolved)
        Assert.Equal("N5144B.Root", baseDefinition.Missing!!.FullName)
        Assert.False(leaf.Kinds.IsValueType)
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func ACoreLibrary_DefinesItsOwnSpecialTypes_EvenWhenAReferenceAssemblyComesFirst() {
        // The reference assembly System.Runtime owns the well-known names. System.Private.CoreLib derives its
        // structs, enums and delegates from its own System.ValueType, System.Enum and System.MulticastDelegate.
        let runtimePath = FindReferenceAssembly("System.Runtime.dll")
        let runtime = ReferenceImageSet(
            System
                .Collections
                .Immutable
                .ImmutableArray
                .Create(ReferenceImage(File.ReadAllBytes(runtimePath), runtimePath, true))
        ).Modules[0]
        let coreLibPath = typeof(object).Assembly.Location
        let uriPath = typeof(Uri).Assembly.Location
        let set = ReferenceImageSet(
            System
                .Collections
                .Immutable
                .ImmutableArray
                .Create(
                ReferenceImage(runtime.Image, runtime.Path, true),
                ReferenceImage(File.ReadAllBytes(coreLibPath), coreLibPath, true),
                ReferenceImage(File.ReadAllBytes(uriPath), uriPath, true)
            )
        )
        // The precondition: the reference assembly defines the name itself, so it is the table entry.
        Assert.Contains("System.ValueType", runtime.DefinedNames)
        let coreLib = set.FindModule("System.Private.CoreLib")!!
        Assert.True(coreLib.IsCoreLibrary)
        Assert.True(Symbol(coreLib, "System.DateTime").Kinds.IsValueType)
        Assert.True(Symbol(coreLib, "System.DayOfWeek").Kinds.IsEnum)
        Assert.True(Symbol(coreLib, "System.Action").Kinds.IsDelegate)
        // A module that is not a core library reaches CoreLib's types through a type reference.
        let uri = set.FindModule("System.Private.Uri")!!
        Assert.True(Symbol(uri, "System.Uri+Flags").Kinds.IsEnum)
        Assert.True(Symbol(uri, "System.Uri+Offset").Kinds.IsValueType)
        Assert.False(Symbol(coreLib, "System.Enum").Kinds.IsValueType)
        Assert.False(Symbol(coreLib, "System.ValueType").Kinds.IsValueType)
    }

    @Fact
    func DelegateKind_IncludesTheDelegateBaseTypesAndTheTypesBelowThem() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        let coreLib = set.FindModule("System.Private.CoreLib")!!
        Assert.True(Symbol(coreLib, "System.Delegate").Kinds.IsDelegate)
        Assert.True(Symbol(coreLib, "System.MulticastDelegate").Kinds.IsDelegate)
        Assert.True(Symbol(coreLib, "System.Action").Kinds.IsDelegate)
        Assert.False(Symbol(coreLib, "System.Object").Kinds.IsDelegate)
        Assert.False(Symbol(coreLib, "System.IDisposable").Kinds.IsDelegate)
        // The context's helper gives the same answers for the same types.
        Assert.True(ClrTypeUtilities.IsDelegateType(typeof(Delegate)))
        Assert.True(ClrTypeUtilities.IsDelegateType(typeof(MulticastDelegate)))
    }

    @Fact
    func ABaseTheSetLacks_StillComparesTheTypesOwnRow() {
        // Leaf<T> derives from a missing type. The name, the arity and the generic parameter rows are still compared.
        using let lib = CSharpFixture("namespace N5144G { public class Root {} }", assemblyName: "RootG5144")
        using let derived = CSharpFixture(
            "public class Leaf5144<T, U> : N5144G.Root {}",
            []MetadataReference{MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "LeafG5144"
        )
        using let resolver = HandleResolver([]string{derived.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("LeafG5144")!!
        let leaf = Symbol(module, "Leaf5144`2")
        Assert.False(leaf.BaseDefinition!!.IsResolved)
        Assert.Equal(2, leaf.GenericParameters.Length)
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
        // The description keeps the parameter rows although the base is missing, on both sides.
        let described = MetadataModelComparison.DescribeSymbol(leaf)
        Assert.Contains("T:0:0,U:1:0", described)
        Assert.EndsWith("|base-missing", described)
        Assert.Equal(
            described,
            MetadataModelComparison.DescribeType(resolver.FindTypeForComparison("LeafG5144", "Leaf5144`2")!!)
        )
    }

    @Fact
    func AMissingGrandparent_IsNormalizedLikeAMissingParent() {
        // Leaf : Middle : Root, with only Root's assembly missing. The context cannot walk the chain.
        using let lib = CSharpFixture("namespace N5144H { public class Root {} }", assemblyName: "RootH5144")
        using let middle = CSharpFixture(
            "namespace N5144H { public class Middle : Root {} }",
            []MetadataReference{MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "MiddleH5144"
        )
        using let leaf = CSharpFixture(
            "public class LeafH5144<T> : N5144H.Middle {}",
            []MetadataReference{
                MetadataReference.CreateFromFile(lib.AssemblyPath),
                MetadataReference.CreateFromFile(middle.AssemblyPath)
            },
            assemblyName: "LeafH5144"
        )
        using let resolver = HandleResolver([]string{middle.AssemblyPath, leaf.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("LeafH5144")!!
        let symbol = Symbol(module, "LeafH5144`1")
        Assert.True(symbol.BaseDefinition!!.IsResolved)
        Assert.False(symbol.IsBaseChainComplete)
        let described = MetadataModelComparison.DescribeSymbol(symbol)
        Assert.Contains("T:0:0", described)
        Assert.EndsWith("|base-missing", described)
        Assert.Equal(
            described,
            MetadataModelComparison.DescribeType(resolver.FindTypeForComparison("LeafH5144", "LeafH5144`1")!!)
        )
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AResolvedHierarchyLongerThanTheReferenceLimit_IsComplete() {
        // 70 classes, each deriving from the one before. Inheritance has no depth limit.
        let source = System.Text.StringBuilder("namespace N5144D { public class C0 {}")
        for var i = 1; i < 70; i++ {
            source.Append(" public class C").Append(i).Append(" : C").Append(i - 1).Append(" {}")
        }
        source.Append(" }")
        using let fixture = CSharpFixture(source.ToString(), assemblyName: "Deep5144D")
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Deep5144D")!!
        let deepest = Symbol(module, "N5144D.C69")
        Assert.True(deepest.IsBaseChainComplete)
        Assert.False(deepest.Kinds.IsDelegate)
        Assert.DoesNotContain("base-missing", MetadataModelComparison.DescribeSymbol(deepest))
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func ACyclicBaseChain_EndsAndIsIncomplete() {
        // Two classes that derive from each other. A malformed chain must end the walk, not hang it.
        let metadata = MetadataBuilder()
        metadata.AddModule(
            0,
            metadata.GetOrAddString("Cycle5144D.dll"),
            metadata.GetOrAddGuid(Guid.NewGuid()),
            GuidHandle(),
            GuidHandle()
        )
        metadata.AddAssembly(
            metadata.GetOrAddString("Cycle5144D"),
            Version(1, 0, 0, 0),
            StringHandle(),
            BlobHandle(),
            cast[AssemblyFlags](0),
            AssemblyHashAlgorithm.None
        )
        metadata.AddTypeDefinition(
            cast[TypeAttributes](0),
            StringHandle(),
            metadata.GetOrAddString("<Module>"),
            EntityHandle(),
            MetadataTokens.FieldDefinitionHandle(1),
            MetadataTokens.MethodDefinitionHandle(1)
        )
        metadata.AddTypeDefinition(
            TypeAttributes.Public,
            metadata.GetOrAddString("N"),
            metadata.GetOrAddString("A"),
            MetadataTokens.TypeDefinitionHandle(3),
            MetadataTokens.FieldDefinitionHandle(1),
            MetadataTokens.MethodDefinitionHandle(1)
        )
        metadata.AddTypeDefinition(
            TypeAttributes.Public,
            metadata.GetOrAddString("N"),
            metadata.GetOrAddString("B"),
            MetadataTokens.TypeDefinitionHandle(2),
            MetadataTokens.FieldDefinitionHandle(1),
            MetadataTokens.MethodDefinitionHandle(1)
        )
        let image = System.Reflection.Metadata.BlobBuilder()
        System
            .Reflection
            .PortableExecutable
            .ManagedPEBuilder(
            System.Reflection.PortableExecutable.PEHeaderBuilder.CreateLibraryHeader(),
            System.Reflection.Metadata.Ecma335.MetadataRootBuilder(metadata),
            System.Reflection.Metadata.BlobBuilder()
        )
            .Serialize(image)
        let set = ReferenceImageSet(
            System.Collections.Immutable.ImmutableArray.Create(ReferenceImage(image.ToArray(), nil, true))
        )
        let a = Symbol(set.Modules[0], "N.A")
        Assert.False(a.IsBaseChainComplete)
        Assert.False(a.Kinds.IsDelegate)
    }

    @Fact
    func TwoAssembliesWithTheSameBaseName_AreToldApart() {
        using let baseA = CSharpFixture("namespace N5144S { public class Base {} }", assemblyName: "BaseA5144")
        using let baseB = CSharpFixture("namespace N5144S { public class Base {} }", assemblyName: "BaseB5144")
        using let derived = CSharpFixture(
            "public class Derived5144 : N5144S.Base {}",
            []MetadataReference{MetadataReference.CreateFromFile(baseB.AssemblyPath)},
            assemblyName: "DerivedS5144"
        )
        // BaseA5144 comes first, so a lookup by name alone would pick it.
        using let resolver = HandleResolver([]string{baseA.AssemblyPath, baseB.AssemblyPath, derived.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("DerivedS5144")!!
        let derivedSymbol = Symbol(module, "Derived5144")
        Assert.Equal("BaseB5144", derivedSymbol.BaseDefinition!!.Module!!.Identity.Name)
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
        // The comparison key holds the defining assembly, on both sides.
        let described = MetadataModelComparison.DescribeSymbol(derivedSymbol)
        Assert.EndsWith("BaseB5144!N5144S.Base", described)
        Assert.Equal(
            described,
            MetadataModelComparison.DescribeType(resolver.FindTypeForComparison("DerivedS5144", "Derived5144")!!)
        )
    }

    @Fact
    func OneSymbolForOneRow_EvenWhenManyThreadsAskAtOnce() {
        using let resolver = HandleResolver([]string{typeof(ReferenceResolver).Assembly.Location})
        let set = resolver.ImageSet!!
        let module = set.Modules[0]
        module.TryGetDefinition(module.DefinedNames[0], out var handle)
        let seen = System.Collections.Concurrent.ConcurrentBag[MetadataTypeSymbol]()
        Parallel.For(0, 64, (i int32) -> seen.Add(module.GetTypeSymbol(handle)))
        Assert.Equal(1, seen.Distinct().Count())
    }

    shared {
        // The reference pack that the build itself compiles against: dotnet/packs/Microsoft.NETCore.App.Ref/<version>/ref/<tfm>.
        private func FindReferenceAssembly(fileName string) string {
            let dotnetRoot = Path.GetFullPath(
                Path.Combine(System.Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", "..")
            )
            let packs = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            var best string? = nil
            for version in Directory.GetDirectories(packs).OrderBy((d string) -> d, StringComparer.Ordinal) {
                for tfm in Directory.GetDirectories(Path.Combine(version, "ref")).OrderBy(
                    (d string) -> d,
                    StringComparer.Ordinal
                ) {
                    let candidate = Path.Combine(tfm, fileName)
                    if File.Exists(candidate) {
                        best = candidate
                    }
                }
            }
            Assert.NotNull(best)
            return best!!
        }

        private func Symbol(module MetadataModule, name string) MetadataTypeSymbol {
            module.TryGetDefinition(name, out var handle)
            return module.GetTypeSymbol(handle)
        }

        private func HandleResolver(paths[]string) ReferenceResolver {
            using let override_ = MetadataModel.Override(MetadataModelMode.Handles)
            return ReferenceResolver.WithReferences(paths)
        }
    }
}
