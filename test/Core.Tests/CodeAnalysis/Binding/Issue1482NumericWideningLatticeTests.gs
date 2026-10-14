// <copyright file="Issue1482NumericWideningLatticeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import Xunit

/// Issue #1482: the implicit numeric-widening lattice (ADR-0044 / C# §6.1.2)
/// used to be hand-copied into (cref:Conversion) and
/// (cref:ClrOverloadResolution), and the two copies had DIVERGED — the
/// overload-resolution copy was missing every native-width integer
/// (`nint`/`nuint` = `System.IntPtr`/`System.UIntPtr`) row.
/// These tests pin the now-single source of truth
/// ((cref:NumericWideningLattice)) and guard against the copies drifting
/// apart again by cross-checking every numeric-primitive pair across all three
/// consumers (the lattice, the conversion classifier, and overload ranking).
open class Issue1482NumericWideningLatticeTests {
    @Fact
    func NumericPrimitiveSet_MatchesLatticeDefinition() {
        // The lattice owns the canonical numeric-primitive universe; this test's
        // fixture table must cover exactly that universe or the consistency
        // guard below would silently skip rows.
        let fromLattice = NumericWideningLattice.NumericPrimitiveClrNames.OrderBy(
            (n string) -> n,
            StringComparer.Ordinal
        )
        let fromFixture = NumericPrimitives.Select((p(ClrName string, ClrType Type, Symbol TypeSymbol)) -> p.ClrName)
            .OrderBy((n string) -> n, StringComparer.Ordinal)
        Assert.Equal(fromLattice, fromFixture)
        // The TypeSymbol mapped to each CLR name agrees with its ClrType, so the
        // cross-consumer checks compare like with like.
        for (clrName, clrType, symbol) in NumericPrimitives {
            Assert.Equal(clrName, clrType.FullName)
            Assert.Equal(clrName, symbol.ClrType!!.FullName)
        }
    }

    @Fact
    func WideningRelation_IsIdenticalAcrossAllConsumers_ForEveryPrimitivePair() {
        // The core anti-drift guard: for EVERY ordered pair of distinct numeric
        // primitives, the shared lattice, the conversion classifier, and the
        // overload "better conversion" ranker must agree on whether the source
        // implicitly widens to the target. Native-int (nint/nuint) rows are part
        // of this sweep, so this fails if the overload copy is ever reintroduced
        // without them (the original divergence).
        let mismatches = List[string]()
        for source in NumericPrimitives {
            for target in NumericPrimitives {
                if object.ReferenceEquals(source.Symbol, target.Symbol) {
                    continue
                }
                let latticeWidens = NumericWideningLattice.IsWidening(source.ClrName, target.ClrName)
                let conversionImplicit = Conversion.Classify(source.Symbol, target.Symbol).IsImplicit
                let overloadWidens = ClrOverloadResolution.ClassifyImplicit(
                    target.ClrType,
                    source.ClrType
                ) == ClrOverloadResolution
                    .ImplicitConversionKind
                    .NumericWidening
                if latticeWidens != conversionImplicit || latticeWidens != overloadWidens {
                    mismatches.Add(
                        "${source.ClrName} -> ${target.ClrName}: lattice=$latticeWidens, " +
                            "conversion=$conversionImplicit, overload=$overloadWidens"
                    )
                }
            }
        }
        Assert.True(
            mismatches.Count == 0,
            "Widening relation drifted between consumers:\n" + string.Join("\n", mismatches)
        )
    }

    @Theory
    @MemberData("NativeIntWideningRows")
    func NativeIntRows_ArePinned_AndVisibleToOverloadRanking(fromClr string, toClr string, expectedWidens bool) {
        // Pin the native-int lattice rows explicitly...
        Assert.Equal(expectedWidens, NumericWideningLattice.IsWidening(fromClr, toClr))
        // ...and assert the consumers (which previously disagreed for native
        // ints) now see exactly the same edges.
        let source = Issue1482NumericWideningLatticeTests.Lookup(fromClr)
        let target = Issue1482NumericWideningLatticeTests.Lookup(toClr)
        Assert.Equal(expectedWidens, Conversion.Classify(source.Symbol, target.Symbol).IsImplicit)
        let overloadWidens = ClrOverloadResolution.ClassifyImplicit(
            target.ClrType,
            source.ClrType
        ) == ClrOverloadResolution
            .ImplicitConversionKind
            .NumericWidening
        Assert.Equal(expectedWidens, overloadWidens)
    }

    @Fact
    func NIntArgument_RanksInt64OverDouble_AgreeingWithConversion() {
        // The concrete consequence from issue #1482: a nint argument against
        // overloads taking int64 vs. double. Before the fix the overload copy
        // lacked the nint rows, so BOTH overloads were judged inapplicable and
        // the call failed to resolve. Now both are applicable and the closer
        // widening target (int64) wins — the same ranking the conversion layer
        // implies (nint → int64 → double).
        Assert.True(Conversion.Classify(TypeSymbol.NInt, TypeSymbol.Int64).IsImplicit)
        Assert.True(Conversion.Classify(TypeSymbol.NInt, TypeSymbol.Float64).IsImplicit)
        Assert.True(Conversion.Classify(TypeSymbol.Int64, TypeSymbol.Float64).IsImplicit)
        Assert.False(Conversion.Classify(TypeSymbol.Float64, TypeSymbol.Int64).IsImplicit)
        // int64 is the better conversion target than double for a nint source.
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(int64), typeof(float64), typeof(nint)) < 0)
        let int64Overload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue1482NumericWideningLatticeTests+NIntFixture"
        )
            .GetMethod("TakeInt64", BindingFlags.Public | BindingFlags.Static)
        let doubleOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue1482NumericWideningLatticeTests+NIntFixture"
        )
            .GetMethod("TakeDouble", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{int64Overload!!, doubleOverload!!},
            []Type{typeof(nint)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("TakeInt64", result.Best!!.Name)
    }

    @Fact
    func NUIntArgument_RanksUInt64OverDouble_AgreeingWithConversion() {
        // Symmetric nuint case: nuint → uint64 → double, so uint64 wins.
        Assert.True(Conversion.Classify(TypeSymbol.NUInt, TypeSymbol.UInt64).IsImplicit)
        Assert.True(Conversion.Classify(TypeSymbol.NUInt, TypeSymbol.Float64).IsImplicit)
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(uint64), typeof(float64), typeof(nuint)) < 0)
        let uint64Overload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue1482NumericWideningLatticeTests+NIntFixture"
        )
            .GetMethod("TakeUInt64", BindingFlags.Public | BindingFlags.Static)
        let doubleOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.Issue1482NumericWideningLatticeTests+NIntFixture"
        )
            .GetMethod("TakeDouble", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{uint64Overload!!, doubleOverload!!},
            []Type{typeof(nuint)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("TakeUInt64", result.Best!!.Name)
    }

    shared {
        // CLR full name → (System.Type, TypeSymbol) for every numeric primitive in
        // the lattice. typeof(nint)/typeof(nuint) have FullName System.IntPtr /
        // System.UIntPtr, matching the lattice keys.
        private let NumericPrimitives[](ClrName string, ClrType Type, Symbol TypeSymbol) = [](
            ClrName string,
            ClrType Type,
            Symbol TypeSymbol
        ){
            ("System.SByte", typeof(int8), TypeSymbol.Int8),
            ("System.Byte", typeof(uint8), TypeSymbol.UInt8),
            ("System.Int16", typeof(int16), TypeSymbol.Int16),
            ("System.UInt16", typeof(uint16), TypeSymbol.UInt16),
            ("System.Int32", typeof(int32), TypeSymbol.Int32),
            ("System.UInt32", typeof(uint32), TypeSymbol.UInt32),
            ("System.Int64", typeof(int64), TypeSymbol.Int64),
            ("System.UInt64", typeof(uint64), TypeSymbol.UInt64),
            ("System.IntPtr", typeof(nint), TypeSymbol.NInt),
            ("System.UIntPtr", typeof(nuint), TypeSymbol.NUInt),
            ("System.Single", typeof(float32), TypeSymbol.Float32),
            ("System.Double", typeof(float64), TypeSymbol.Float64),
            ("System.Decimal", typeof(decimal), TypeSymbol.Decimal),
            ("System.Char", typeof(char), TypeSymbol.Char)
        }

        func NativeIntWideningRows() sequence[[]object] {
            // nint (System.IntPtr) widens to int64/single/double/decimal.
            yield[]object{"System.IntPtr", "System.Int64", true}
            yield[]object{"System.IntPtr", "System.Single", true}
            yield[]object{"System.IntPtr", "System.Double", true}
            yield[]object{"System.IntPtr", "System.Decimal", true}
            // nint does NOT widen to unsigned 64-bit nor narrow to int32.
            yield[]object{"System.IntPtr", "System.UInt64", false}
            yield[]object{"System.IntPtr", "System.Int32", false}
            // nuint (System.UIntPtr) widens to uint64/single/double/decimal.
            yield[]object{"System.UIntPtr", "System.UInt64", true}
            yield[]object{"System.UIntPtr", "System.Single", true}
            yield[]object{"System.UIntPtr", "System.Double", true}
            yield[]object{"System.UIntPtr", "System.Decimal", true}
            // nuint does NOT widen to signed int64.
            yield[]object{"System.UIntPtr", "System.Int64", false}
            // The narrower integral and char sources widen INTO the native ints.
            yield[]object{"System.SByte", "System.IntPtr", true}
            yield[]object{"System.Byte", "System.IntPtr", true}
            yield[]object{"System.Byte", "System.UIntPtr", true}
            yield[]object{"System.Int16", "System.IntPtr", true}
            yield[]object{"System.UInt16", "System.IntPtr", true}
            yield[]object{"System.UInt16", "System.UIntPtr", true}
            yield[]object{"System.Int32", "System.IntPtr", true}
            yield[]object{"System.UInt32", "System.UIntPtr", true}
            yield[]object{"System.Char", "System.IntPtr", true}
            yield[]object{"System.Char", "System.UIntPtr", true}
            // uint32 does NOT widen to the signed native int (it can be wider).
            yield[]object{"System.UInt32", "System.IntPtr", false}
        }

        private func Lookup(clrName string)(ClrType Type, Symbol TypeSymbol) {
            let entry = NumericPrimitives.First(
                (p(ClrName string, ClrType Type, Symbol TypeSymbol)) -> p.ClrName == clrName
            )
            return (entry.ClrType, entry.Symbol)
        }
    }
}
