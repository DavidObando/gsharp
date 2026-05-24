// <copyright file="OverloadResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Stream F: pure unit tests for <see cref="OverloadResolution"/> focused on
/// numeric "better conversion target" tie-breaking (C# §7.5.3.4). Builds tiny
/// fixture method sets via reflection so we can drive the resolver directly
/// without going through the binder.
/// </summary>
public class OverloadResolutionTests
{
    [Fact]
    public void Resolve_PrefersIdentityOverWidening()
    {
        var resolved = Resolve(nameof(Fixture.F_Int_Long), nameof(Fixture.F_Long_Long), new[] { typeof(int), typeof(long) });
        Assert.Equal(nameof(Fixture.F_Int_Long), resolved.Name);
    }

    [Fact]
    public void Resolve_PrefersSmallerNumericTarget_LongOverFloat()
    {
        // int → long is implicit and long → float is implicit, so long is a
        // better conversion target than float per C# §7.5.3.4.
        var resolved = Resolve(nameof(Fixture.F_Long), nameof(Fixture.F_Float), new[] { typeof(int) });
        Assert.Equal(nameof(Fixture.F_Long), resolved.Name);
    }

    [Fact]
    public void Resolve_PrefersSmallerNumericTarget_IntOverDouble()
    {
        // short → int is implicit and int → double is implicit, so int beats
        // double when binding a short argument.
        var resolved = Resolve(nameof(Fixture.F_Int), nameof(Fixture.F_Double), new[] { typeof(short) });
        Assert.Equal(nameof(Fixture.F_Int), resolved.Name);
    }

    [Fact]
    public void Resolve_PrefersSignedOverUnsigned_IntBeatsUInt()
    {
        // From a short argument, neither int→uint nor uint→int is implicit.
        // The signed/unsigned subclause of §7.5.3.4 picks the signed target.
        var resolved = Resolve(nameof(Fixture.F_Int), nameof(Fixture.F_UInt), new[] { typeof(short) });
        Assert.Equal(nameof(Fixture.F_Int), resolved.Name);
    }

    [Fact]
    public void Resolve_AmbiguousWhenNeitherNumericTargetDominates()
    {
        // From an int argument, neither float→decimal nor decimal→float is
        // implicit, and neither type appears in the signed-vs-unsigned table,
        // so the two widenings tie and the resolver reports ambiguity.
        var first = typeof(Fixture).GetMethod(nameof(Fixture.F_Float), BindingFlags.Public | BindingFlags.Static);
        var second = typeof(Fixture).GetMethod(nameof(Fixture.F_Decimal), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { first, second }, new[] { typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome);
    }

    [Fact]
    public void Resolve_TieBreakAppliesPerArgument()
    {
        // (int, int) args; pick F_Long_Long over F_Float_Float for both args.
        var resolved = Resolve(
            nameof(Fixture.F_Long_Long),
            nameof(Fixture.F_Float_Float),
            new[] { typeof(int), typeof(int) });
        Assert.Equal(nameof(Fixture.F_Long_Long), resolved.Name);
    }

    [Fact]
    public void CompareNumericTargets_LongBeatsFloatFromInt()
    {
        Assert.True(OverloadResolution.CompareNumericTargets(typeof(long), typeof(float), typeof(int)) < 0);
        Assert.True(OverloadResolution.CompareNumericTargets(typeof(float), typeof(long), typeof(int)) > 0);
    }

    [Fact]
    public void CompareNumericTargets_IntBeatsUIntFromShort()
    {
        Assert.True(OverloadResolution.CompareNumericTargets(typeof(int), typeof(uint), typeof(short)) < 0);
    }

    [Fact]
    public void CompareNumericTargets_EqualTargetsCompareZero()
    {
        Assert.Equal(0, OverloadResolution.CompareNumericTargets(typeof(int), typeof(int), typeof(short)));
    }

    private static MethodInfo Resolve(string a, string b, Type[] argTypes)
    {
        var first = typeof(Fixture).GetMethod(a, BindingFlags.Public | BindingFlags.Static);
        var second = typeof(Fixture).GetMethod(b, BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(first);
        Assert.NotNull(second);
        var result = OverloadResolution.Resolve(new[] { first, second }, argTypes);
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        return result.Best;
    }

    public static class Fixture
    {
        public static void F_Int(int x) { _ = x; }

        public static void F_UInt(uint x) { _ = x; }

        public static void F_Long(long x) { _ = x; }

        public static void F_Float(float x) { _ = x; }

        public static void F_Decimal(decimal x) { _ = x; }

        public static void F_Double(double x) { _ = x; }

        public static void F_Int_Long(int a, long b) { _ = a; _ = b; }

        public static void F_Long_Long(long a, long b) { _ = a; _ = b; }

        public static void F_Float_Float(float a, float b) { _ = a; _ = b; }
    }
}
