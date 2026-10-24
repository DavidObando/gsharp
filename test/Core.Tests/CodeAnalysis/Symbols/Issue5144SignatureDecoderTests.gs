// <copyright file="Issue5144SignatureDecoderTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import AssemblyIdentity = GSharp.Core.CodeAnalysis.Symbols.AssemblyIdentity
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import Xunit

/// ADR-0209 PR 2b (#5144): the signature decoder, type parameter symbols with constraints, and interned constructions.
/// The expected texts are written out, not computed by the product.
open class Issue5144SignatureDecoderTests {
    @Fact
    func ASignature_DecodesToTheCanonicalSymbols() {
        using let fixture = CSharpFixture(
            "using System; using System.Collections.Generic; namespace N5144D { public class S { public void M<T>(int a, string b, int[] c, int[,] d, ref decimal f, T g, List<int> h, int? i, Dictionary<string, List<T>>[] j, S k, IComparable<S> l) {} } }",
            assemblyName: "Decode5144D"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Decode5144D")!!
        let method = FindMethod(module, "M")
        let parameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        parameter.IsMethodTypeParameter = true
        let context = MetadataGenericContext(
            ImmutableArray[TypeSymbol].Empty,
            ImmutableArray.Create[TypeSymbol](parameter)
        )
        let signature = method.DecodeSignature[TypeSymbol, MetadataGenericContext](module.Decoder, context)
        let keys = signature.ParameterTypes.Select((t TypeSymbol) -> MetadataTypeKeys.Of(t)).ToArray()
        Assert.Equal("System.Void", MetadataTypeKeys.Of(signature.ReturnType))
        Assert.Equal(
            []string{
                "System.Int32",
                "System.String",
                "System.Int32[]",
                "System.Int32[,]",
                "System.Decimal&",
                "!!0",
                "System.Private.CoreLib!System.Collections.Generic.List`1<System.Int32>",
                "System.Nullable`1<System.Int32>",
                "System.Private.CoreLib!System.Collections.Generic.Dictionary`2<System.String,System.Private.CoreLib!System.Collections.Generic.List`1<!!0>>[]",
                "Decode5144D!N5144D.S",
                "System.Private.CoreLib!System.IComparable`1<Decode5144D!N5144D.S>"
            },
            keys
        )
        // The canonical forms are the process-wide symbols, not metadata definitions.
        Assert.Same(TypeSymbol.Int32, signature.ParameterTypes[0])
        Assert.Same(TypeSymbol.Decimal, (cast[ByRefTypeSymbol](signature.ParameterTypes[4])).PointeeType)
        Assert.IsType[NullableTypeSymbol](signature.ParameterTypes[7])
        Assert.IsType[ConstructedMetadataTypeSymbol](signature.ParameterTypes[6])
        Assert.IsType[MetadataArrayTypeSymbol](signature.ParameterTypes[2])
        Assert.IsType[RectangularArrayTypeSymbol](signature.ParameterTypes[3])
        // The same signature decodes to the same objects: arrays and constructions are interned.
        let again = method.DecodeSignature[TypeSymbol, MetadataGenericContext](module.Decoder, context)
        for var i = 0; i < keys.Length; i++ {
            Assert.Same(signature.ParameterTypes[i], again.ParameterTypes[i])
        }
    }

    @Fact
    func ConstraintsAreDecoded_InTableOrder_WithSelfReference() {
        using let fixture = CSharpFixture(
            "using System; namespace N5144C { public interface IV<in A, out B> {} public class Box<T, U, V, W> where T : class, IComparable<T>, new() where U : T where V : struct where W : Exception, IDisposable {} }",
            assemblyName: "Constraints5144C"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Constraints5144C")!!
        module.TryGetDefinition("N5144C.Box`4", out var handle)
        let box = module.GetTypeSymbol(handle)
        let parameters = box.TypeParameters
        Assert.Equal(4, parameters.Length)
        let t = parameters[0]
        Assert.True(t.HasReferenceTypeConstraint)
        Assert.True(t.HasDefaultConstructorConstraint)
        Assert.Equal("System.Private.CoreLib!System.IComparable`1<!0>", MetadataTypeKeys.Of(t.ClrInterfaceConstraint))
        // The constraint names the parameter itself, and it is the same object.
        Assert.Same(t, (cast[ConstructedMetadataTypeSymbol](t.ClrInterfaceConstraint)).TypeArguments[0])
        Assert.Same(t, parameters[1].TypeParameterBound)
        Assert.True(parameters[2].HasValueTypeConstraint)
        // The System.ValueType row stays in the full list, and out of the legacy reference-type slot.
        Assert.Null(parameters[2].ClassConstraint)
        Assert.Equal("System.Private.CoreLib!System.ValueType", MetadataTypeKeys.Of(box.GetConstraintTypes(2)[0]))
        let w = parameters[3]
        Assert.Equal("System.Private.CoreLib!System.Exception", MetadataTypeKeys.Of(w.ClassConstraint))
        Assert.Equal("System.Private.CoreLib!System.IDisposable", MetadataTypeKeys.Of(w.ClrInterfaceConstraint))
        Assert.Equal(2, box.GetConstraintTypes(3).Length)
        module.TryGetDefinition("N5144C.IV`2", out var variantHandle)
        let variant = module.GetTypeSymbol(variantHandle)
        Assert.Equal(TypeParameterVariance.In, variant.TypeParameters[0].Variance)
        Assert.Equal(TypeParameterVariance.Out, variant.TypeParameters[1].Variance)
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AConstraintTheSetLacks_IsAMissingType_AndTheTypeStillCompares() {
        using let lib = CSharpFixture("namespace N5144L { public class Gone {} }", assemblyName: "Gone5144L")
        using let user = CSharpFixture(
            "public class Holder5144L<T> where T : N5144L.Gone {}",
            []Microsoft
                .CodeAnalysis
                .MetadataReference{Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "Holder5144L"
        )
        using let resolver = HandleResolver([]string{user.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Holder5144L")!!
        module.TryGetDefinition("Holder5144L`1", out var handle)
        let holder = module.GetTypeSymbol(handle)
        Assert.IsType[MissingTypeSymbol](holder.GetConstraintTypes(0)[0])
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AMissingTypeArgumentInTheBase_NormalizesTheBaseDependentPart() {
        using let baseLib = CSharpFixture("namespace N5144M { public class Base<T> {} }", assemblyName: "BaseLib5144M")
        using let goneLib = CSharpFixture("namespace N5144M { public class Gone {} }", assemblyName: "GoneLib5144M")
        using let derived = CSharpFixture(
            "public class Derived5144M : N5144M.Base<N5144M.Gone> {}",
            []Microsoft
                .CodeAnalysis
                .MetadataReference{
                Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(baseLib.AssemblyPath),
                Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(goneLib.AssemblyPath)
            },
            assemblyName: "Derived5144M"
        )
        // GoneLib5144M is not in the set; BaseLib5144M is.
        using let resolver = HandleResolver([]string{baseLib.AssemblyPath, derived.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Derived5144M")!!
        module.TryGetDefinition("Derived5144M", out var handle)
        let symbol = module.GetTypeSymbol(handle)
        Assert.True(symbol.BaseDefinition!!.IsResolved)
        Assert.True(MetadataTypeKeys.ContainsMissing(symbol.BaseType))
        Assert.False(symbol.IsBaseChainComplete)
        Assert.Contains("|base-missing|", MetadataModelComparison.DescribeSymbol(symbol))
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func AnEnumConstraint_IsNotAReferenceTypeBound() {
        using let fixture = CSharpFixture(
            "using System; namespace N5144E { public class Enums<E, D> where E : Enum where D : Delegate {} }",
            assemblyName: "Enums5144E"
        )
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let module = resolver.ImageSet!!.FindModule("Enums5144E")!!
        module.TryGetDefinition("N5144E.Enums`2", out var handle)
        let symbol = module.GetTypeSymbol(handle)
        // An enum is a value type, so System.Enum bounds no reference type. System.Delegate does.
        Assert.Null(symbol.TypeParameters[0].ClassConstraint)
        Assert.Equal(
            "System.Private.CoreLib!System.Delegate",
            MetadataTypeKeys.Of(symbol.TypeParameters[1].ClassConstraint)
        )
        Assert.Equal(1, symbol.GetConstraintTypes(0).Length)
    }

    @Fact
    func AMissingConstraint_NormalizesOnlyItsOwnParameter() {
        using let lib = CSharpFixture("namespace N5144P { public class Gone {} }", assemblyName: "GoneP5144")
        using let user = CSharpFixture(
            "using System; public class Pair5144P<A, B> where A : N5144P.Gone where B : IDisposable {}",
            []Microsoft
                .CodeAnalysis
                .MetadataReference{Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "Pair5144P"
        )
        using let resolver = HandleResolver([]string{user.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("Pair5144P")!!
        module.TryGetDefinition("Pair5144P`2", out var handle)
        let symbol = module.GetTypeSymbol(handle)
        let described = MetadataModelComparison.DescribeSymbol(symbol)
        Assert.EndsWith("constraints-missing,System.Private.CoreLib!System.IDisposable", described)
        Assert.Equal(
            described,
            MetadataModelComparison.DescribeType(resolver.FindTypeForComparison("Pair5144P", "Pair5144P`2")!!)
        )
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func ARankOneNonVectorArray_IsItsOwnSymbolAndKey() {
        using let fixture = CSharpFixture("public class Any5144R {}", assemblyName: "Rank5144R")
        using let resolver = HandleResolver([]string{fixture.AssemblyPath})
        let module = resolver.ImageSet!!.FindModule("Rank5144R")!!
        let shape = ArrayShape(1, ImmutableArray[int32].Empty, ImmutableArray[int32].Empty)
        let nonVector = module.Decoder.GetArrayType(TypeSymbol.Int32, shape)
        let vector = module.Decoder.GetSZArrayType(TypeSymbol.Int32)
        Assert.NotSame(vector, nonVector)
        Assert.Same(nonVector, module.Decoder.GetArrayType(TypeSymbol.Int32, shape))
        Assert.Equal("System.Int32[*]", MetadataTypeKeys.Of(nonVector))
        Assert.Equal("System.Int32[]", MetadataTypeKeys.Of(vector))
        // Reflection spells the same two shapes the same two ways.
        Assert.Equal("System.Int32[*]", MetadataTypeKeys.Of(typeof(int32).MakeArrayType(1)))
        Assert.Equal("System.Int32[]", MetadataTypeKeys.Of(typeof(int32).MakeArrayType()))
        Assert.Equal("System.Int32[,]", MetadataTypeKeys.Of(typeof(int32).MakeArrayType(2)))
    }

    @Fact
    func ANamesakeOfABuiltIn_IsNotTheBuiltIn() {
        // An assembly that is not a core library defines System.Nullable`1 itself. The name alone does not make it the
        // framework type, in the decoder and in the key.
        using let namesake = CSharpFixture(
            "namespace System { public class Nullable<T> where T : struct {} public struct Decimal {} } public class Holder5144N : System.Nullable<int> {}",
            assemblyName: "Namesake5144N"
        )
        let coreLibPath = typeof(object).Assembly.Location
        let set = ReferenceImageSet(
            ImmutableArray.Create(
                ReferenceImage(System.IO.File.ReadAllBytes(coreLibPath), coreLibPath, true),
                ReferenceImage(System.IO.File.ReadAllBytes(namesake.AssemblyPath), namesake.AssemblyPath, true)
            )
        )
        let module = set.FindModule("Namesake5144N")!!
        module.TryGetDefinition("Holder5144N", out var handle)
        let holder = module.GetTypeSymbol(handle)
        Assert.IsType[ConstructedMetadataTypeSymbol](holder.BaseType)
        Assert.Equal("Namesake5144N!System.Nullable`1<System.Int32>", MetadataTypeKeys.Of(holder.BaseType))
        // The namesake definition of a built-in name keeps its assembly in the key.
        module.TryGetDefinition("System.Decimal", out var decimalHandle)
        Assert.Equal("Namesake5144N!System.Decimal", MetadataTypeKeys.Of(module.GetTypeSymbol(decimalHandle)))
        Assert.Equal("System.Nullable`1<System.Int32>", MetadataTypeKeys.Of(typeof(Nullable[int32])))
    }

    @Fact
    func ANamesakeThatComesFirst_IsNotCanonicalizedToTheBuiltInOrNullable() {
        using let namesake = CSharpFixture(
            "namespace System { public class Nullable<T> where T : struct {} public struct Decimal {} }",
            assemblyName: "NamesakeFirst5144"
        )
        let coreLibPath = typeof(object).Assembly.Location
        // The namesake comes first, so it is the first writer of both names in the table.
        let set = ReferenceImageSet(
            ImmutableArray.Create(
                ReferenceImage(System.IO.File.ReadAllBytes(namesake.AssemblyPath), namesake.AssemblyPath, true),
                ReferenceImage(System.IO.File.ReadAllBytes(coreLibPath), coreLibPath, true)
            )
        )
        let module = set.FindModule("NamesakeFirst5144")!!
        module.TryGetDefinition("System.Decimal", out var decimalHandle)
        module.TryGetDefinition("System.Nullable`1", out var nullableHandle)
        let decoder = module.Decoder
        let decimalSymbol = decoder.GetTypeFromDefinition(module.Reader, decimalHandle, 0)
        Assert.NotSame(TypeSymbol.Decimal, decimalSymbol)
        Assert.IsType[MetadataTypeSymbol](decimalSymbol)
        let nullableSymbol = decoder.GetTypeFromDefinition(module.Reader, nullableHandle, 0)
        Assert.IsType[ConstructedMetadataTypeSymbol](
            decoder.GetGenericInstantiation(nullableSymbol, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        )
        // The framework copies still canonicalize.
        let coreLib = set.FindModule("System.Private.CoreLib")!!
        coreLib.TryGetDefinition("System.Decimal", out var frameworkDecimal)
        Assert.Same(TypeSymbol.Decimal, coreLib.Decoder.GetTypeFromDefinition(coreLib.Reader, frameworkDecimal, 0))
    }

    @Fact
    func AReadableConstraint_StillComparesWhenTheBaseIsMissing() {
        using let lib = CSharpFixture("namespace N5144Q { public class Root {} }", assemblyName: "RootQ5144")
        using let leaf = CSharpFixture(
            "using System; public class Leaf5144Q<T> : N5144Q.Root where T : IDisposable {}",
            []Microsoft
                .CodeAnalysis
                .MetadataReference{Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(lib.AssemblyPath)},
            assemblyName: "LeafQ5144"
        )
        using let resolver = HandleResolver([]string{leaf.AssemblyPath})
        let set = resolver.ImageSet!!
        let module = set.FindModule("LeafQ5144")!!
        module.TryGetDefinition("Leaf5144Q`1", out var handle)
        let symbol = module.GetTypeSymbol(handle)
        let described = MetadataModelComparison.DescribeSymbol(symbol)
        Assert.Contains("|base-missing|System.Private.CoreLib!System.IDisposable", described)
        Assert.Equal(
            described,
            MetadataModelComparison.DescribeType(resolver.FindTypeForComparison("LeafQ5144", "Leaf5144Q`1")!!)
        )
        Assert.Empty(MetadataModelComparison.Compare(resolver, set))
    }

    @Fact
    func TheKeyRules_SpellSymbolsAndReflectionTypesTheSameWay() {
        Assert.Equal("System.Int32[]", MetadataTypeKeys.Of(typeof([]int32)))
        Assert.Equal("System.Int32[,]", MetadataTypeKeys.Of(typeof([,]int32)))
        Assert.Equal("System.Nullable`1<System.Int32>", MetadataTypeKeys.Of(typeof(Nullable[int32])))
        Assert.Equal("System.Nullable`1<System.Int32>", MetadataTypeKeys.Of(NullableTypeSymbol.Get(TypeSymbol.Int32)))
        Assert.Equal("System.Int32*", MetadataTypeKeys.Of(PointerTypeSymbol.Get(TypeSymbol.Int32)))
    }

    shared {
        private func HandleResolver(paths[]string) ReferenceResolver {
            using let override_ = MetadataModel.Override(MetadataModelMode.Handles)
            return ReferenceResolver.WithReferences(paths)
        }

        private func FindMethod(module MetadataModule, name string) MethodDefinition {
            for handle in module.Reader.MethodDefinitions {
                let method = module.Reader.GetMethodDefinition(handle)
                if module.Reader.GetString(method.Name) == name {
                    return method
                }
            }
            throw InvalidOperationException(name)
        }
    }
}
