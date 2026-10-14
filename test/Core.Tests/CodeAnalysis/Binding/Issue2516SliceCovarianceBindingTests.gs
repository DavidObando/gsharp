// <copyright file="Issue2516SliceCovarianceBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import Xunit

/// Issue #2516 conversion-matrix guards for source slices, imported CLR
/// arrays, nullable envelopes, overload resolution, and invariant targets.
open class Issue2516SliceCovarianceBindingTests {
    @Fact
    func SourceSlice_ComposesCovariantInterfaceAndNullableEnvelope() {
        let source = SliceTypeSymbol.Get(TypeSymbol.String)
        let direct = Conversion.Classify(source, EnumerableObject)
        let nullable = Conversion.Classify(source, NullableTypeSymbol.Get(EnumerableObject))
        Assert.True(direct.Exists && direct.IsImplicit)
        Assert.True(nullable.Exists && nullable.IsImplicit)
    }

    @Fact
    func SourceSlice_RejectsMutableArrayAndValueTypeVariance() {
        let strings = SliceTypeSymbol.Get(TypeSymbol.String)
        let integers = SliceTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(Conversion.Classify(strings, ListObject).Exists)
        Assert.False(Conversion.Classify(integers, EnumerableObject).Exists)
        // Issue #3685: `[]string -> []object` gained an EXPLICIT spelling
        // (`cast[[]object](strings)`), so the conversion now exists — but the
        // #2516 invariance rule is unchanged, which is what this guard pins:
        // it must never be IMPLICIT.
        let covariantSlice = Conversion.Classify(strings, SliceTypeSymbol.Get(TypeSymbol.Object))
        Assert.True(covariantSlice.Exists)
        Assert.False(covariantSlice.IsImplicit)
    }

    @Fact
    func ImportedArray_UsesSameSafeVarianceMatrix() {
        let strings = TypeSymbol.FromClrType(typeof([]string))
        Assert.True(Conversion.Classify(strings, EnumerableObject) is {Exists: true, IsImplicit: true})
        Assert.False(Conversion.Classify(strings, ListObject).Exists)
        // Issue #3685, imported-array arm of the same rule: explicit-only.
        let covariantArray = Conversion.Classify(strings, TypeSymbol.FromClrType(typeof([]object)))
        Assert.True(covariantArray.Exists)
        Assert.False(covariantArray.IsImplicit)
    }

    @Fact
    func ClrOverloadClassification_UsesDeclaredVarianceOnly() {
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.Reference,
            ClrOverloadResolution.ClassifyImplicit(typeof(IEnumerable[object]), typeof([]string))
        )
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(IList[object]), typeof([]string))
        )
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof([]object), typeof([]string))
        )
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(IEnumerable[object]), typeof([]int32))
        )
        Assert.Equal(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(typeof(ICovariant[object]), typeof([]string))
        )
    }

    private interface ICovariant[out T] { }

    shared {
        private let EnumerableObject TypeSymbol = TypeSymbol.FromClrType(typeof(IEnumerable[object]))
        private let ListObject TypeSymbol = TypeSymbol.FromClrType(typeof(IList[object]))
    }
}
