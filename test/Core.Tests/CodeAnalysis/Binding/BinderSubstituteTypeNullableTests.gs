// <copyright file="BinderSubstituteTypeNullableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

class BinderSubstituteTypeNullableTests {
    @Fact
    func ImportedGeneric_ConcreteNullableSubstitution_PreservesNullableClrArgument() {
        let typeParameter = TypeParameter()
        let openDefinition = typeof(List[_])
        let imported = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(typeof(object)),
            openDefinition,
            ImmutableArray.Create[TypeSymbol](typeParameter)
        )
        let substituted = Binder.SubstituteType(
            imported,
            Dictionary[TypeParameterSymbol, TypeSymbol]{[typeParameter] = NullableTypeSymbol.Get(TypeSymbol.Int32)}
        )
        Assert.Equal(typeof(List[int32?]), substituted.ClrType)
    }

    @Fact
    func ImportedGeneric_UnconstrainedNullableTypeParameter_PreservesErasure() {
        let typeParameter = TypeParameter()
        let openDefinition = typeof(List[_])
        let imported = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(typeof(object)),
            openDefinition,
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(typeParameter))
        )
        let substituted = Binder.SubstituteType(
            imported,
            Dictionary[TypeParameterSymbol, TypeSymbol]{[typeParameter] = TypeSymbol.Int32}
        )
        Assert.Equal(typeof(List[int32]), substituted.ClrType)
    }

    @Fact
    func ImportedGeneric_UnconstrainedNullableTypeParameter_PreservesNullableActualType() {
        let typeParameter = TypeParameter()
        let openDefinition = typeof(List[_])
        let imported = ImportedTypeSymbol.GetConstructed(
            openDefinition.MakeGenericType(typeof(object)),
            openDefinition,
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(typeParameter))
        )
        let substituted = Binder.SubstituteType(
            imported,
            Dictionary[TypeParameterSymbol, TypeSymbol]{[typeParameter] = NullableTypeSymbol.Get(TypeSymbol.Int32)}
        )
        Assert.Equal(typeof(List[int32?]), substituted.ClrType)
    }

    shared {
        private func TypeParameter() TypeParameterSymbol -> TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
    }
}
