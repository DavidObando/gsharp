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
