// <copyright file="Issue2516SliceCovarianceBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Reflection
import System.Runtime.InteropServices
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

    @Fact
    func VariantArrayArgument_PreservesOuterPlatformAndAnnotatedElementNullability() {
        let nonNullStringSlice = SliceTypeSymbol.Get(TypeSymbol.String)
        let platformStringSlice = PlatformTypeSymbol.Get(nonNullStringSlice)
        let nonNullObjectSlice = SliceTypeSymbol.Get(TypeSymbol.Object)
        let nullableObjectSlice = NullableTypeSymbol.Get(nonNullObjectSlice)
        Assert.False(
            Conversion.IsVarianceArgumentCompatible(
                platformStringSlice,
                nonNullObjectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                platformStringSlice,
                nonNullObjectSlice,
                allowPlatformNilCheck: true
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                platformStringSlice,
                nullableObjectSlice,
                allowPlatformNilCheck: false
            )
        )

        let nullableStringsArray = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof([]string)),
            ImmutableArray.Create[uint8](uint8(1), uint8(2))
        )
        let nonNullObjectsArray = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof([]object)),
            ImmutableArray.Create[uint8](uint8(1), uint8(1))
        )
        let nullableObjectsArray = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof([]object)),
            ImmutableArray.Create[uint8](uint8(1), uint8(2))
        )
        Assert.False(
            Conversion.IsVarianceArgumentCompatible(
                nullableStringsArray,
                nonNullObjectsArray,
                allowPlatformNilCheck: false
            )
        )
        Assert.False(
            Conversion.IsVarianceArgumentCompatible(
                nullableStringsArray,
                nonNullObjectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                nullableStringsArray,
                nullableObjectsArray,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                NullableTypeSymbol.Get(TypeSymbol.String),
                PlatformTypeSymbol.Get(TypeSymbol.Object),
                allowPlatformNilCheck: false
            )
        )
        let platformIntSlice = PlatformTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.Int32))
        let nullableIntSlice = NullableTypeSymbol.Get(SliceTypeSymbol.Get(TypeSymbol.Int32))
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(platformIntSlice, nullableIntSlice, allowPlatformNilCheck: false)
        )
    }

    @Fact
    func ClrAssignabilityByName_RejectsPointersAndGuardsRecursiveVarianceCycles() {
        let intPointer = typeof(int32).MakePointerType()
        let intPointerArray = intPointer.MakeArrayType()
        Assert.False(ClrTypeUtilities.IsAssignableByName(typeof(object), intPointer))
        Assert.False(ClrTypeUtilities.IsAssignableByName(typeof([]object), intPointerArray))

        let runtimePaths = Directory.GetFiles(RuntimeEnvironment.GetRuntimeDirectory(), "*.dll")
        let paths = List[string](runtimePaths)
        paths.Add(typeof(Issue2516SliceCovarianceBindingTests).Assembly.Location)
        using let mlc = MetadataLoadContext(PathAssemblyResolver(paths))
        let mlcAssembly = mlc.LoadFromAssemblyPath(typeof(Issue2516SliceCovarianceBindingTests).Assembly.Location)
        let mlcRight = mlcAssembly.GetType(typeof(RecursiveRight).FullName ?? "")
        Assert.NotNull(mlcRight)
        Assert.False(ClrTypeUtilities.IsAssignableByName(typeof(IRecursiveContra[RecursiveLeft]), mlcRight))

        let flags = BindingFlags.NonPublic | BindingFlags.Instance
        let unconstrained = typeof(Issue2516SliceCovarianceBindingTests)
            .GetMethod(nameof(UnconstrainedGenericArray), flags)
            ?.GetGenericArguments()[0]
            .MakeArrayType()
        let structConstrained = typeof(Issue2516SliceCovarianceBindingTests)
            .GetMethod(nameof(StructConstrainedGenericArray), flags)
            ?.GetGenericArguments()[0]
            .MakeArrayType()
        let classConstrained = typeof(Issue2516SliceCovarianceBindingTests)
            .GetMethod(nameof(ClassConstrainedGenericArray), flags)
            ?.GetGenericArguments()[0]
            .MakeArrayType()
        let baseClassConstrained = typeof(Issue2516SliceCovarianceBindingTests)
            .GetMethod(nameof(BaseClassConstrainedGenericArray), flags)
            ?.GetGenericArguments()[0]
            .MakeArrayType()
        let dependentClassConstrained = typeof(Issue2516SliceCovarianceBindingTests)
            .GetMethod(nameof(DependentClassConstrainedGenericArray), flags)
            ?.GetGenericArguments()[0]
            .MakeArrayType()
        let dependentBaseClassConstrained = typeof(Issue2516SliceCovarianceBindingTests)
            .GetMethod(nameof(DependentBaseClassConstrainedGenericArray), flags)
            ?.GetGenericArguments()[0]
            .MakeArrayType()
        Assert.False(ClrTypeUtilities.IsAssignableByName(typeof([]object), unconstrained))
        Assert.False(ClrTypeUtilities.IsAssignableByName(typeof([]object), structConstrained))
        Assert.True(ClrTypeUtilities.IsAssignableByName(typeof([]object), classConstrained))
        Assert.True(ClrTypeUtilities.IsAssignableByName(typeof([]object), baseClassConstrained))
        Assert.True(ClrTypeUtilities.IsAssignableByName(typeof([]object), dependentClassConstrained))
        Assert.True(ClrTypeUtilities.IsAssignableByName(typeof([]object), dependentBaseClassConstrained))

        let objectSlice = TypeSymbol.FromClrType(typeof([]object))
        Assert.False(
            Conversion.IsVarianceArgumentCompatible(
                TypeSymbol.FromClrType(unconstrained ?? typeof(void)),
                objectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.False(
            Conversion.IsVarianceArgumentCompatible(
                TypeSymbol.FromClrType(structConstrained ?? typeof(void)),
                objectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                TypeSymbol.FromClrType(classConstrained ?? typeof(void)),
                objectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                TypeSymbol.FromClrType(baseClassConstrained ?? typeof(void)),
                objectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                TypeSymbol.FromClrType(dependentClassConstrained ?? typeof(void)),
                objectSlice,
                allowPlatformNilCheck: false
            )
        )
        Assert.True(
            Conversion.IsVarianceArgumentCompatible(
                TypeSymbol.FromClrType(dependentBaseClassConstrained ?? typeof(void)),
                objectSlice,
                allowPlatformNilCheck: false
            )
        )
    }

    private func UnconstrainedGenericArray[TUnconstrained]() { }

    private func StructConstrainedGenericArray[TStruct struct]() { }

    private func ClassConstrainedGenericArray[TClass class]() { }

    private func BaseClassConstrainedGenericArray[TBase Exception]() { }

    private func DependentClassConstrainedGenericArray[TDepClass UClass, UClass class]() { }

    private func DependentBaseClassConstrainedGenericArray[TDepBase UBase, UBase Exception]() { }

    private interface ICovariant[out T] { }

    private interface IRecursiveContra[in T] { }

    private sealed class RecursiveLeft : IRecursiveContra[IRecursiveContra[RecursiveLeft]] { }

    private sealed class RecursiveRight : IRecursiveContra[IRecursiveContra[RecursiveRight]] { }

    shared {
        private let EnumerableObject TypeSymbol = TypeSymbol.FromClrType(typeof(IEnumerable[object]))
        private let ListObject TypeSymbol = TypeSymbol.FromClrType(typeof(IList[object]))
    }
}
