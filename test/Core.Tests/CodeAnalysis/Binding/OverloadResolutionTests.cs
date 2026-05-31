// <copyright file="OverloadResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
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

    [Fact]
    public void InferTypeArguments_Identity_BindsTFromArgument()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Identity), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(string) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(string) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_PairWithConsistentBounds_Succeeds()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(int) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_PairWithConflictingBounds_Fails()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(string) }, out var typeArgs);
        Assert.False(ok);
        Assert.Null(typeArgs);
    }

    [Fact]
    public void InferTypeArguments_TwoParam_BindsBothIndependently()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_TwoParam), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(string) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int), typeof(string) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Array_UnwrapsElementType()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Array), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(int[]) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Enumerable_FromList_WalksInterface()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Enumerable), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(System.Collections.Generic.List<int>) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Dictionary_BindsBothKeyAndValue()
    {
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_DictionaryFromValues), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(
            open,
            new[] { typeof(System.Collections.Generic.Dictionary<string, int>) },
            out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(string), typeof(int) }, typeArgs);
    }

    [Fact]
    public void Resolve_ClosesOpenGenericMethod_FromInferableArgs()
    {
        // Enumerable.Repeat<TResult>(TResult element, int count) is open
        // generic. Passing (int, int) should infer TResult = int and return
        // the closed MethodInfo with the correct return type.
        var open = typeof(System.Linq.Enumerable)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(m => m.Name == nameof(System.Linq.Enumerable.Repeat) && m.IsGenericMethodDefinition);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(int), typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethodDefinition);
        Assert.Equal(typeof(int), result.Best.GetGenericArguments()[0]);
        Assert.Equal(typeof(System.Collections.Generic.IEnumerable<int>), result.Best.ReturnType);
    }

    [Fact]
    public void Resolve_DropsOpenGenericWhenInferenceFails()
    {
        // G_Pair<T>(T, T) called with (int, string) cannot infer T — the
        // candidate must be dropped silently (NoneApplicable, not Ambiguous).
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(int), typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_OmitsTrailingOptionalParameter()
    {
        // Issue #327: O_OneOptional(int, CancellationToken = default) is
        // applicable when called with a single int argument; the optional
        // trailing parameter is omitted. Mirrors HttpResponse.WriteAsync(text).
        var method = typeof(Fixture).GetMethod(nameof(Fixture.O_OneOptional), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { method }, new[] { typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(Fixture.O_OneOptional), result.Best.Name);
    }

    [Fact]
    public void Resolve_OmitsTrailingOptionalParameter_StillAppliesWithAllArgs()
    {
        // The same candidate is still applicable when the optional argument is
        // supplied explicitly.
        var method = typeof(Fixture).GetMethod(nameof(Fixture.O_OneOptional), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { method }, new[] { typeof(int), typeof(System.Threading.CancellationToken) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
    }

    [Fact]
    public void Resolve_RejectsCandidateWithNonOptionalMissingParameter()
    {
        // O_Required(int, int) has no optional parameters; calling with a single
        // argument leaves a non-optional parameter unfilled and is not applicable.
        var method = typeof(Fixture).GetMethod(nameof(Fixture.O_Required), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { method }, new[] { typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_PrefersFewerParametersWhenOptionalsTie()
    {
        // Issue #327: O_OneOptional(int, CancellationToken = default) and
        // O_TwoOptional(int, CancellationToken = default, CancellationToken =
        // default) both apply to a single int argument. The overload requiring
        // fewer omitted optionals wins (C# §7.5.3.2).
        var oneOpt = typeof(Fixture).GetMethod(nameof(Fixture.O_OneOptional), BindingFlags.Public | BindingFlags.Static);
        var twoOpt = typeof(Fixture).GetMethod(nameof(Fixture.O_TwoOptional), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { oneOpt, twoOpt }, new[] { typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(Fixture.O_OneOptional), result.Best.Name);
    }

    [Fact]
    public void Resolve_OmitsTrailingOptionalParameter_OnOpenGenericMethod()
    {
        // Issue #327: Enumerable.CountBy<TSource,TKey>(IEnumerable<TSource>,
        // Func<TSource,TKey>, IEqualityComparer<TKey> = null) is open generic
        // with a trailing optional. Inference must succeed from the first two
        // arguments while the optional comparer is omitted.
        var open = typeof(System.Linq.Enumerable)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(m => m.Name == nameof(System.Linq.Enumerable.CountBy) && m.IsGenericMethodDefinition);
        var result = OverloadResolution.Resolve(
            new[] { open },
            new[] { typeof(System.Collections.Generic.IEnumerable<int>), typeof(Func<int, int>) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethodDefinition);
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

        // Generic fixtures for TryInferTypeArguments tests below.
        public static T G_Identity<T>(T x) => x;

        public static void G_Pair<T>(T a, T b) { _ = a; _ = b; }

        public static void G_TwoParam<TA, TB>(TA a, TB b) { _ = a; _ = b; }

        public static void G_Array<T>(T[] xs) { _ = xs; }

        public static void G_Enumerable<T>(System.Collections.Generic.IEnumerable<T> xs) { _ = xs; }

        public static void G_DictionaryFromValues<TK, TV>(System.Collections.Generic.Dictionary<TK, TV> map) { _ = map; }

        // Issue #327: optional-parameter fixtures.
        public static void O_OneOptional(int a, System.Threading.CancellationToken token = default) { _ = a; _ = token; }

        public static void O_TwoOptional(int a, System.Threading.CancellationToken first = default, System.Threading.CancellationToken second = default) { _ = a; _ = first; _ = second; }

        public static void O_Required(int a, int b) { _ = a; _ = b; }
    }
}
