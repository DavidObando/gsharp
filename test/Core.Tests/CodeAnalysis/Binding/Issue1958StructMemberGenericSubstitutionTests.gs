// <copyright file="Issue1958StructMemberGenericSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Regression test mirroring (cref:Issue1958InterfaceMemberGenericSubstitutionTests):
/// `StructSymbol.SubstituteTypeForConstruction` had the identical
/// un-projected `MakeGenericType` erasure bug as `InterfaceSymbol`
/// before this fix (blocking review #2032). A G# `struct S[T]` with an
/// imported generic-CLR-typed field over the struct's OWN type parameter
/// (e.g. `IEnumerator[T]`) would silently erase to the definition's
/// open `T` when constructed under a
/// (cref:System.Reflection.MetadataLoadContext)-style resolver, because
/// `StructSymbol.Construct` dropped the projector on the floor instead of
/// threading it (like `InterfaceSymbol.Construct`) into
/// `MakeGenericType`.
open class Issue1958StructMemberGenericSubstitutionTests {
    @Fact
    func StructSymbol_SubstituteTypeForConstruction_ProjectsClrArgsAcrossReflectionContexts() {
        // Direct symbol-layer check (mirrors the interface-layer test): a
        // struct definition Box[T] with a field typed as a constructed CLR
        // generic (IEnumerator[T]) over the struct's OWN type parameter must,
        // when constructed as Box[int32] under a mapClrType-bearing resolver,
        // substitute T -> int32 in the field's imported generic type. Before
        // the fix, StructSymbol.Construct dropped mapClrType on the floor, so
        // MakeGenericType mixed the MLC-resolved open definition with the
        // host runtime's typeof(int) CLR arg, threw ArgumentException, and
        // silently fell back to the still-open `IEnumerator[T]` field type.
        let resolver = MetadataLoadContextResolver()
        let mapClrType Func[Type?, Type?]? = resolver.MapClrTypeToReferences
        let enumeratorOpenDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerator[_]))
        let mlcObject = resolver.MapClrTypeToReferences(typeof(object))
        let tp = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let erasedFieldType = ImportedTypeSymbol.GetConstructed(
            enumeratorOpenDef.MakeGenericType(mlcObject),
            enumeratorOpenDef,
            ImmutableArray.Create[TypeSymbol](tp)
        )
        let fields = ImmutableArray.Create(FieldSymbol("Items", erasedFieldType, Accessibility.Public))
        let definition = StructSymbol("Box", fields, Accessibility.Public, declaration: nil, packageName: "P")
        definition.SetTypeParameters(ImmutableArray.Create(tp))
        let constructed = StructSymbol.Construct(
            definition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32),
            mapClrType
        )
        let substitutedFieldType = Assert.IsType[ImportedTypeSymbol](constructed.Fields[0].Type)
        Assert.Same(TypeSymbol.Int32, Assert.Single(substitutedFieldType.TypeArguments))
    }

    @Fact
    func StructSymbol_SubstituteTypeForConstruction_WithoutMapClrType_ErasesUnderMetadataLoadContext() {
        // Control case proving the failure mode this test guards against: with
        // no projector supplied (mapClrType: null, the pre-#1958 behavior),
        // MakeGenericType throws under MLC and the fix's own graceful fallback
        // (catch -> Debug.WriteLine + return the erased member) kicks in, so
        // the field type stays the still-open `IEnumerator[T]` instead of
        // throwing out of Construct entirely.
        let resolver = MetadataLoadContextResolver()
        let enumeratorOpenDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerator[_]))
        let mlcObject = resolver.MapClrTypeToReferences(typeof(object))
        let tp = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let erasedFieldType = ImportedTypeSymbol.GetConstructed(
            enumeratorOpenDef.MakeGenericType(mlcObject),
            enumeratorOpenDef,
            ImmutableArray.Create[TypeSymbol](tp)
        )
        let fields = ImmutableArray.Create(FieldSymbol("Items", erasedFieldType, Accessibility.Public))
        let definition = StructSymbol("Box", fields, Accessibility.Public, declaration: nil, packageName: "P")
        definition.SetTypeParameters(ImmutableArray.Create(tp))
        let constructed = StructSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let unsubstitutedFieldType = Assert.IsType[ImportedTypeSymbol](constructed.Fields[0].Type)
        Assert.Same(tp, Assert.Single(unsubstitutedFieldType.TypeArguments))
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the BCL reference
        /// assemblies, forcing gsc into the (cref:System.Reflection.MetadataLoadContext)
        /// resolution path — reproducing the cross-reflection-context scenario
        /// inside the unit-test process. Mirrors
        /// `Issue1958InterfaceMemberGenericSubstitutionTests.MetadataLoadContextResolver`.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }
    }
}
