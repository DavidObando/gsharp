// <copyright file="Issue1482NumericWideningLatticeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1482: the implicit numeric-widening lattice (ADR-0044 / C# §6.1.2)
/// used to be hand-copied into <see cref="Conversion"/> and
/// <see cref="OverloadResolution"/>, and the two copies had DIVERGED — the
/// overload-resolution copy was missing every native-width integer
/// (<c>nint</c>/<c>nuint</c> = <c>System.IntPtr</c>/<c>System.UIntPtr</c>) row.
/// These tests pin the now-single source of truth
/// (<see cref="NumericWideningLattice"/>) and guard against the copies drifting
/// apart again by cross-checking every numeric-primitive pair across all three
/// consumers (the lattice, the conversion classifier, and overload ranking).
/// </summary>
public class Issue1482NumericWideningLatticeTests
{
    // CLR full name → (System.Type, TypeSymbol) for every numeric primitive in
    // the lattice. typeof(nint)/typeof(nuint) have FullName System.IntPtr /
    // System.UIntPtr, matching the lattice keys.
    private static readonly (string ClrName, Type ClrType, TypeSymbol Symbol)[] NumericPrimitives =
    {
        ("System.SByte", typeof(sbyte), TypeSymbol.Int8),
        ("System.Byte", typeof(byte), TypeSymbol.UInt8),
        ("System.Int16", typeof(short), TypeSymbol.Int16),
        ("System.UInt16", typeof(ushort), TypeSymbol.UInt16),
        ("System.Int32", typeof(int), TypeSymbol.Int32),
        ("System.UInt32", typeof(uint), TypeSymbol.UInt32),
        ("System.Int64", typeof(long), TypeSymbol.Int64),
        ("System.UInt64", typeof(ulong), TypeSymbol.UInt64),
        ("System.IntPtr", typeof(nint), TypeSymbol.NInt),
        ("System.UIntPtr", typeof(nuint), TypeSymbol.NUInt),
        ("System.Single", typeof(float), TypeSymbol.Float32),
        ("System.Double", typeof(double), TypeSymbol.Float64),
        ("System.Decimal", typeof(decimal), TypeSymbol.Decimal),
        ("System.Char", typeof(char), TypeSymbol.Char),
    };

    [Fact]
    public void NumericPrimitiveSet_MatchesLatticeDefinition()
    {
        // The lattice owns the canonical numeric-primitive universe; this test's
        // fixture table must cover exactly that universe or the consistency
        // guard below would silently skip rows.
        var fromLattice = NumericWideningLattice.NumericPrimitiveClrNames.OrderBy(n => n, StringComparer.Ordinal);
        var fromFixture = NumericPrimitives.Select(p => p.ClrName).OrderBy(n => n, StringComparer.Ordinal);
        Assert.Equal(fromLattice, fromFixture);

        // The TypeSymbol mapped to each CLR name agrees with its ClrType, so the
        // cross-consumer checks compare like with like.
        foreach (var (clrName, clrType, symbol) in NumericPrimitives)
        {
            Assert.Equal(clrName, clrType.FullName);
            Assert.Equal(clrName, symbol.ClrType.FullName);
        }
    }

    [Fact]
    public void WideningRelation_IsIdenticalAcrossAllConsumers_ForEveryPrimitivePair()
    {
        // The core anti-drift guard: for EVERY ordered pair of distinct numeric
        // primitives, the shared lattice, the conversion classifier, and the
        // overload "better conversion" ranker must agree on whether the source
        // implicitly widens to the target. Native-int (nint/nuint) rows are part
        // of this sweep, so this fails if the overload copy is ever reintroduced
        // without them (the original divergence).
        var mismatches = new List<string>();

        foreach (var source in NumericPrimitives)
        {
            foreach (var target in NumericPrimitives)
            {
                if (ReferenceEquals(source.Symbol, target.Symbol))
                {
                    continue;
                }

                var latticeWidens = NumericWideningLattice.IsWidening(source.ClrName, target.ClrName);
                var conversionImplicit = Conversion.Classify(source.Symbol, target.Symbol).IsImplicit;
                var overloadWidens =
                    OverloadResolution.ClassifyImplicit(target.ClrType, source.ClrType)
                    == OverloadResolution.ImplicitConversionKind.NumericWidening;

                if (latticeWidens != conversionImplicit || latticeWidens != overloadWidens)
                {
                    mismatches.Add(
                        $"{source.ClrName} -> {target.ClrName}: lattice={latticeWidens}, " +
                        $"conversion={conversionImplicit}, overload={overloadWidens}");
                }
            }
        }

        Assert.True(mismatches.Count == 0, "Widening relation drifted between consumers:\n" + string.Join("\n", mismatches));
    }

    public static IEnumerable<object[]> NativeIntWideningRows()
    {
        // nint (System.IntPtr) widens to int64/single/double/decimal.
        yield return new object[] { "System.IntPtr", "System.Int64", true };
        yield return new object[] { "System.IntPtr", "System.Single", true };
        yield return new object[] { "System.IntPtr", "System.Double", true };
        yield return new object[] { "System.IntPtr", "System.Decimal", true };

        // nint does NOT widen to unsigned 64-bit nor narrow to int32.
        yield return new object[] { "System.IntPtr", "System.UInt64", false };
        yield return new object[] { "System.IntPtr", "System.Int32", false };

        // nuint (System.UIntPtr) widens to uint64/single/double/decimal.
        yield return new object[] { "System.UIntPtr", "System.UInt64", true };
        yield return new object[] { "System.UIntPtr", "System.Single", true };
        yield return new object[] { "System.UIntPtr", "System.Double", true };
        yield return new object[] { "System.UIntPtr", "System.Decimal", true };

        // nuint does NOT widen to signed int64.
        yield return new object[] { "System.UIntPtr", "System.Int64", false };

        // The narrower integral and char sources widen INTO the native ints.
        yield return new object[] { "System.SByte", "System.IntPtr", true };
        yield return new object[] { "System.Byte", "System.IntPtr", true };
        yield return new object[] { "System.Byte", "System.UIntPtr", true };
        yield return new object[] { "System.Int16", "System.IntPtr", true };
        yield return new object[] { "System.UInt16", "System.IntPtr", true };
        yield return new object[] { "System.UInt16", "System.UIntPtr", true };
        yield return new object[] { "System.Int32", "System.IntPtr", true };
        yield return new object[] { "System.UInt32", "System.UIntPtr", true };
        yield return new object[] { "System.Char", "System.IntPtr", true };
        yield return new object[] { "System.Char", "System.UIntPtr", true };

        // uint32 does NOT widen to the signed native int (it can be wider).
        yield return new object[] { "System.UInt32", "System.IntPtr", false };
    }

    [Theory]
    [MemberData(nameof(NativeIntWideningRows))]
    public void NativeIntRows_ArePinned_AndVisibleToOverloadRanking(string fromClr, string toClr, bool expectedWidens)
    {
        // Pin the native-int lattice rows explicitly...
        Assert.Equal(expectedWidens, NumericWideningLattice.IsWidening(fromClr, toClr));

        // ...and assert the consumers (which previously disagreed for native
        // ints) now see exactly the same edges.
        var source = Lookup(fromClr);
        var target = Lookup(toClr);

        Assert.Equal(expectedWidens, Conversion.Classify(source.Symbol, target.Symbol).IsImplicit);

        var overloadWidens =
            OverloadResolution.ClassifyImplicit(target.ClrType, source.ClrType)
            == OverloadResolution.ImplicitConversionKind.NumericWidening;
        Assert.Equal(expectedWidens, overloadWidens);
    }

    [Fact]
    public void NIntArgument_RanksInt64OverDouble_AgreeingWithConversion()
    {
        // The concrete consequence from issue #1482: a nint argument against
        // overloads taking int64 vs. double. Before the fix the overload copy
        // lacked the nint rows, so BOTH overloads were judged inapplicable and
        // the call failed to resolve. Now both are applicable and the closer
        // widening target (int64) wins — the same ranking the conversion layer
        // implies (nint → int64 → double).
        Assert.True(Conversion.Classify(TypeSymbol.NInt, TypeSymbol.Int64).IsImplicit);
        Assert.True(Conversion.Classify(TypeSymbol.NInt, TypeSymbol.Float64).IsImplicit);
        Assert.True(Conversion.Classify(TypeSymbol.Int64, TypeSymbol.Float64).IsImplicit);
        Assert.False(Conversion.Classify(TypeSymbol.Float64, TypeSymbol.Int64).IsImplicit);

        // int64 is the better conversion target than double for a nint source.
        Assert.True(OverloadResolution.CompareNumericTargets(typeof(long), typeof(double), typeof(nint)) < 0);

        var int64Overload = typeof(NIntFixture).GetMethod(nameof(NIntFixture.TakeInt64), BindingFlags.Public | BindingFlags.Static);
        var doubleOverload = typeof(NIntFixture).GetMethod(nameof(NIntFixture.TakeDouble), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { int64Overload, doubleOverload }, new[] { typeof(nint) });

        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(NIntFixture.TakeInt64), result.Best.Name);
    }

    [Fact]
    public void NUIntArgument_RanksUInt64OverDouble_AgreeingWithConversion()
    {
        // Symmetric nuint case: nuint → uint64 → double, so uint64 wins.
        Assert.True(Conversion.Classify(TypeSymbol.NUInt, TypeSymbol.UInt64).IsImplicit);
        Assert.True(Conversion.Classify(TypeSymbol.NUInt, TypeSymbol.Float64).IsImplicit);
        Assert.True(OverloadResolution.CompareNumericTargets(typeof(ulong), typeof(double), typeof(nuint)) < 0);

        var uint64Overload = typeof(NIntFixture).GetMethod(nameof(NIntFixture.TakeUInt64), BindingFlags.Public | BindingFlags.Static);
        var doubleOverload = typeof(NIntFixture).GetMethod(nameof(NIntFixture.TakeDouble), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { uint64Overload, doubleOverload }, new[] { typeof(nuint) });

        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(NIntFixture.TakeUInt64), result.Best.Name);
    }

    private static (Type ClrType, TypeSymbol Symbol) Lookup(string clrName)
    {
        var entry = NumericPrimitives.First(p => p.ClrName == clrName);
        return (entry.ClrType, entry.Symbol);
    }

    public static class NIntFixture
    {
        public static void TakeInt64(long x) => _ = x;

        public static void TakeUInt64(ulong x) => _ = x;

        public static void TakeDouble(double x) => _ = x;
    }
}
