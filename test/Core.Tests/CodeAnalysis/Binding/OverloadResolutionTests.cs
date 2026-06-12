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
    public void InferTypeArguments_Enumerable_FromArray_WalksInterface()
    {
        // #611: an array `int[]` implements IEnumerable<int>; the inference
        // should walk interfaces and find T = int.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Enumerable), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(int[]) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Enumerable_FromStringArray_WalksInterface()
    {
        // #611: string[] → IEnumerable<string> inference.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Enumerable), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(string[]) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(string) }, typeArgs);
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

    // --- Issue #661: nullable-aware inference (T vs Nullable<T>) ---

    public enum Quality { Low = 1, High = 2 }

    [Fact]
    public void InferTypeArguments_Pair_NonNullableAndNullableEnum_PromotesToNullable()
    {
        // Issue #661: G_Pair<T>(T, T) with (Quality, Quality?) must infer T = Quality?
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality), typeof(Quality?) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality?) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_NullableEnumAndNonNullable_PromotesToNullable()
    {
        // Issue #661: symmetric — G_Pair<T>(T, T) with (Quality?, Quality) must infer T = Quality?
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality?), typeof(Quality) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality?) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_BothNullableEnum_InfersNullable()
    {
        // Both operands nullable — should infer T = Quality? trivially.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality?), typeof(Quality?) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality?) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_BothNonNullableEnum_InfersNonNullable()
    {
        // Both non-nullable — should infer T = Quality.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality), typeof(Quality) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_NonNullableAndNullableInt_PromotesToNullable()
    {
        // Regression guard: the int case must still work.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Pair), BindingFlags.Public | BindingFlags.Static);
        var ok = OverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(int?) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int?) }, typeArgs);
    }

    [Fact]
    public void Resolve_EqualLike_NonNullableEnumAndNullableEnum_Resolves()
    {
        // Issue #661: Assert.Equal(Quality.High, actual) where actual : Quality?
        var candidates = typeof(EqualLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal");
        var result = OverloadResolution.Resolve(candidates, new[] { typeof(Quality), typeof(Quality?) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(Quality?), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_EqualLike_NullableEnumAndNonNullableEnum_Resolves()
    {
        // Issue #661: symmetric case.
        var candidates = typeof(EqualLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal");
        var result = OverloadResolution.Resolve(candidates, new[] { typeof(Quality?), typeof(Quality) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(Quality?), result.Best.GetGenericArguments()[0]);
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
    public void Resolve_ClosesGenericMethodWithOptionalTrailingParameter_FromInference()
    {
        // Issue #321: this mirrors JsonSerializer.Serialize<TValue>(TValue value,
        // JsonSerializerOptions? options = null). Passing a single (string)
        // argument must infer TValue = string and close the method even though
        // the declared arity is 2 with a trailing optional parameter.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_SerializeLike), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethodDefinition);
        Assert.Equal(typeof(string), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_ProjectsInferredTypeArgument_BeforeClosingGenericMethod()
    {
        // Issue #321: inferred type arguments are live host-runtime Type objects.
        // When the candidate was loaded under a different context, they must be
        // projected before MakeGenericMethod. Verify the projection callback is
        // invoked for the inferred argument and that its result is honored.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Identity), BindingFlags.Public | BindingFlags.Static);
        var seen = new System.Collections.Generic.List<Type>();
        Type Project(Type t)
        {
            seen.Add(t);
            return t;
        }

        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(string) }, explicitTypeArgs: null, projectTypeArgument: Project);
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(string), result.Best.GetGenericArguments()[0]);
        Assert.Contains(typeof(string), seen);
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

    [Fact]
    public void Resolve_InterpolatedStringPrefersStringOverFormattable()
    {
        // ADR-0055 Tier 4 (#369): an interpolated-string argument keeps its
        // natural `string` type for applicability, so the `string` overload (an
        // identity conversion) beats the `FormattableString` overload.
        var stringOverload = typeof(Fixture).GetMethod(nameof(Fixture.F_String), BindingFlags.Public | BindingFlags.Static);
        var formattableOverload = typeof(Fixture).GetMethod(nameof(Fixture.F_FormattableString), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(
            new[] { stringOverload, formattableOverload },
            new[] { typeof(string) },
            interpolatedStringArgs: new[] { true });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(Fixture.F_String), result.Best.Name);
    }

    [Fact]
    public void Resolve_InterpolatedStringIsApplicableToFormattableOnlyOverload()
    {
        // With only a FormattableString overload, the flagged interpolated-string
        // argument is applicable thanks to the Tier 4 relaxation.
        var formattableOverload = typeof(Fixture).GetMethod(nameof(Fixture.F_FormattableString), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(
            new[] { formattableOverload },
            new[] { typeof(string) },
            interpolatedStringArgs: new[] { true });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(Fixture.F_FormattableString), result.Best.Name);
    }

    [Fact]
    public void Resolve_PlainStringIsNotApplicableToFormattableOverload()
    {
        // Regression guard: without the interpolated-string flag a plain `string`
        // argument must NOT convert to FormattableString, so the overload is not
        // applicable. This keeps ordinary string arguments unaffected.
        var formattableOverload = typeof(Fixture).GetMethod(nameof(Fixture.F_FormattableString), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(
            new[] { formattableOverload },
            new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_InterpolatedStringPrefersFormattableStringOverIFormattable()
    {
        // FormattableString implements IFormattable, so it is the more specific
        // (better) target when both overloads apply to an interpolated string.
        var formattableOverload = typeof(Fixture).GetMethod(nameof(Fixture.F_FormattableString), BindingFlags.Public | BindingFlags.Static);
        var iformattableOverload = typeof(Fixture).GetMethod(nameof(Fixture.F_IFormattable), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(
            new[] { iformattableOverload, formattableOverload },
            new[] { typeof(string) },
            interpolatedStringArgs: new[] { true });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(Fixture.F_FormattableString), result.Best.Name);
    }

    [Fact]
    public void IsFormattableStringTarget_RecognizesFormattableTargets()
    {
        Assert.True(OverloadResolution.IsFormattableStringTarget(typeof(System.FormattableString)));
        Assert.True(OverloadResolution.IsFormattableStringTarget(typeof(System.IFormattable)));
        Assert.False(OverloadResolution.IsFormattableStringTarget(typeof(string)));
        Assert.False(OverloadResolution.IsFormattableStringTarget(typeof(object)));
        Assert.False(OverloadResolution.IsFormattableStringTarget(null));
    }

    [Fact]
    public void Resolve_PrefersNonGenericOverGeneric_FromStringStringArgs()
    {
        // Issue #505: mirrors xUnit's Assert.Equal(string, string) (non-generic)
        // vs Assert.Equal<T>(T, T) (generic). Both apply to (string, string) with
        // identity conversions, but per C# §7.5.3.2 the non-generic overload is
        // preferred. Without this tie-break, users had to write `Equal[string]`.
        var nonGeneric = typeof(EqualLike).GetMethod(nameof(EqualLike.Equal_StringString), BindingFlags.Public | BindingFlags.Static);
        var generic = typeof(EqualLike).GetMethod(nameof(EqualLike.Equal_TT), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(
            new[] { generic, nonGeneric },
            new[] { typeof(string), typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(nameof(EqualLike.Equal_StringString), result.Best.Name);
        Assert.False(result.Best.IsGenericMethod);
    }

    [Fact]
    public void Resolve_PrefersNonGenericOverGeneric_AcrossFullEqualOverloadSet()
    {
        // Issue #505: full reproduction with the family of xUnit-style Equal
        // overloads — non-generic Equal(string, string), generic Equal<T>(T, T),
        // generic Equal<T>(T, T, IEqualityComparer<T>), and string/comparison
        // overloads that take extra optional trailing booleans. (string, string)
        // resolves uniquely to the non-generic Equal(string, string).
        var candidates = typeof(EqualLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal" || m.Name.StartsWith("Equal_", StringComparison.Ordinal))
            .ToList();

        // Sanity: the fixture should include several overloads otherwise the
        // test is not actually exercising the disambiguation pass.
        Assert.True(candidates.Count >= 4, "expected a multi-overload fixture");

        // Pass them in via the synthesized `Equal` name on a real CLR Equal
        // probe class so this exercises the same EvaluateCandidate path.
        var nameMatches = candidates.Where(m => m.Name == "Equal").ToList();
        var result = OverloadResolution.Resolve(nameMatches, new[] { typeof(string), typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethod);
        var parameters = result.Best.GetParameters();
        Assert.Equal(2, parameters.Length);
        Assert.Equal(typeof(string), parameters[0].ParameterType);
        Assert.Equal(typeof(string), parameters[1].ParameterType);
    }

    [Fact]
    public void Resolve_ExplicitTypeArgumentStillBindsGeneric_FromStringStringArgs()
    {
        // Issue #505: `Equal[string]("a", "a")` continues to work — the
        // explicit type-argument path picks the generic Equal<T>(T, T) and
        // closes it with T=string. Verifies the explicit-arg path isn't
        // broken by the new non-generic-preference tie-breaker.
        var generic = typeof(EqualLike).GetMethod(nameof(EqualLike.Equal_TT), BindingFlags.Public | BindingFlags.Static);
        var nonGeneric = typeof(EqualLike).GetMethod(nameof(EqualLike.Equal_StringString), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(
            new[] { generic, nonGeneric },
            new[] { typeof(string), typeof(string) },
            explicitTypeArgs: new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.True(result.Best.IsGenericMethod);
        Assert.Equal(typeof(string), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_InferableGenericEqual_FromTwoIntArgs_PicksGeneric_NoAmbiguity()
    {
        // Issue #505: with int arguments and the same family of Equal overloads,
        // only the generic Equal<T>(T, T) (closed with T=int) applies via
        // identity conversion. The string-typed overloads are not applicable
        // and the numeric-widening to other overloads would lose on conversion
        // ranking, so the resolver returns a unique best without ambiguity.
        var candidates = typeof(EqualLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal")
            .ToList();
        var result = OverloadResolution.Resolve(candidates, new[] { typeof(int), typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.True(result.Best.IsGenericMethod);
        Assert.Equal(typeof(int), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_InferableGenericNotEqual_FromTwoStringArgs_PicksNonGeneric()
    {
        // Issue #505 companion: same reasoning for NotEqual. Non-generic
        // NotEqual(string, string) wins over generic NotEqual<T>(T, T).
        var candidates = typeof(EqualLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "NotEqual")
            .ToList();
        var result = OverloadResolution.Resolve(candidates, new[] { typeof(string), typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethod);
        var parameters = result.Best.GetParameters();
        Assert.Equal(typeof(string), parameters[0].ParameterType);
        Assert.Equal(typeof(string), parameters[1].ParameterType);
    }

    [Fact]
    public void Resolve_TrulyAmbiguousOverloads_AreReported_WithCandidateList()
    {
        // Issue #505: when the surviving pool still ties after every C# tie-
        // breaker (e.g. two non-generic overloads taking unrelated reference
        // types, both reachable from the argument by reference conversion),
        // the resolver returns Ambiguous with the competing candidates so the
        // caller can format them into the GS0160 diagnostic.
        var first = typeof(EqualLike).GetMethod(nameof(EqualLike.Take_IA), BindingFlags.Public | BindingFlags.Static);
        var second = typeof(EqualLike).GetMethod(nameof(EqualLike.Take_IB), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { first, second }, new[] { typeof(EqualLike.BothAB) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome);
        Assert.Equal(2, result.Ambiguous.Length);
        var signatures = result.Ambiguous.Select(OverloadResolution.FormatMethodSignature).ToArray();
        Assert.Contains(signatures, s => s.Contains("IA"));
        Assert.Contains(signatures, s => s.Contains("IB"));
    }

    [Fact]
    public void FormatMethodSignature_FormatsGenericMethod_WithBracketedTypeArgs()
    {
        // Issue #505: the diagnostic helper must surface a readable signature
        // including the closed generic type arguments.
        var open = typeof(Fixture).GetMethod(nameof(Fixture.G_Identity), BindingFlags.Public | BindingFlags.Static);
        var closed = open.MakeGenericMethod(typeof(string));
        var formatted = OverloadResolution.FormatMethodSignature(closed);
        Assert.Equal("G_Identity[String](String)", formatted);
    }

    [Fact]
    public void FormatMethodSignature_FormatsNonGenericMethod_PlainParens()
    {
        var method = typeof(Fixture).GetMethod(nameof(Fixture.F_Int), BindingFlags.Public | BindingFlags.Static);
        var formatted = OverloadResolution.FormatMethodSignature(method);
        Assert.Equal("F_Int(Int32)", formatted);
    }

    [Fact]
    public void FormatMethodSignature_FormatsGenericTypeArguments_InParameters()
    {
        // Generic parameter types like IEnumerable<T> should be rendered with
        // bracketed arguments rather than mangled (`IEnumerable`1`) names.
        var method = typeof(Fixture).GetMethod(nameof(Fixture.G_Enumerable), BindingFlags.Public | BindingFlags.Static);
        var closed = method.MakeGenericMethod(typeof(int));
        var formatted = OverloadResolution.FormatMethodSignature(closed);
        Assert.Equal("G_Enumerable[Int32](IEnumerable[Int32])", formatted);
    }

    // ----- Issue #750 / ADR-0088: constraint-aware overload resolution -----

    [Fact]
    public void Resolve_DropsCandidate_WhenClassConstraintViolatedByValueType()
    {
        // ConstraintFixture.OnlyClass<T>(T x) where T : class — calling with an
        // int argument must NOT bind. The MetadataLoadContext-style path won't
        // throw from MakeGenericMethod, so the explicit constraint check has
        // to drop the candidate.
        var open = typeof(ConstraintFixture).GetMethod(nameof(ConstraintFixture.OnlyClass), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DropsCandidate_WhenStructConstraintViolatedByReferenceType()
    {
        var open = typeof(ConstraintFixture).GetMethod(nameof(ConstraintFixture.OnlyStruct), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DropsCandidate_WhenStructConstraintViolatedByNullableValueType()
    {
        // `where T : struct` rejects Nullable<T> — int? is not a "non-nullable
        // value type" per ECMA-335.
        var open = typeof(ConstraintFixture).GetMethod(nameof(ConstraintFixture.OnlyStruct), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(int?) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DropsCandidate_WhenNewConstraintViolated()
    {
        // ConstraintFixture.OnlyNew<T>() where T : new() — string has no
        // public parameterless ctor.
        var open = typeof(ConstraintFixture).GetMethod(nameof(ConstraintFixture.OnlyNew), BindingFlags.Public | BindingFlags.Static);
        var result = OverloadResolution.Resolve(new[] { open }, new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DisjointClassStructOverloads_PicksClassForReferenceType()
    {
        // The repro from issue #750: two extensions with identical parameter
        // shape (modulo the receiver), disjoint class/struct constraints. The
        // binder must pick the class overload when called with a string.
        var both = typeof(MapLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == nameof(MapLike.Map));
        var result = OverloadResolution.Resolve(both, new[] { typeof(string), typeof(Func<string, string>) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        // Class overload's T resolves to string; struct overload couldn't infer
        // T at all from a string receiver.
        Assert.Equal(typeof(string), result.Best.GetGenericArguments()[0]);
        Assert.Equal(typeof(MapLike), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_DisjointClassStructOverloads_PicksStructForNullableValueType()
    {
        var both = typeof(MapLike)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == nameof(MapLike.Map));
        var result = OverloadResolution.Resolve(both, new[] { typeof(int?), typeof(Func<int, int>) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        // Struct overload binds T = int.
        Assert.Equal(typeof(int), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_ThreeWayConstraints_PrefersStructOverNone_ForValueArgument()
    {
        // class, struct, and no-constraint overloads of the same shape. For a
        // non-nullable value type the struct overload wins; the unconstrained
        // overload is dominated by constraint-specificity per ADR-0088.
        var all = ThreeWayCandidates();
        var result = OverloadResolution.Resolve(all, new[] { typeof(int) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(ThreeWayStruct), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_ThreeWayConstraints_PrefersClassOverNone_ForReferenceArgument()
    {
        var all = ThreeWayCandidates();
        var result = OverloadResolution.Resolve(all, new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(ThreeWayClass), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_FallsThroughToUnconstrained_WhenConstrainedCandidatesFail()
    {
        // Receiver is Nullable<int> — neither class (because Nullable<T> is a
        // value type) nor struct (because the struct constraint excludes
        // Nullable<T>) applies. The unconstrained overload survives and wins.
        var all = ThreeWayCandidates();
        var result = OverloadResolution.Resolve(all, new[] { typeof(int?) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(ThreeWayNone), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_SameSpecificityOverloads_ReportsAmbiguity()
    {
        // Two overloads with identical constraints from disjoint declaring
        // classes cannot be disambiguated by the new constraint-specificity
        // tie-break; the existing ambiguity diagnostic fires.
        var all = new[]
        {
            typeof(AmbiguousSameShapeA).GetMethod(nameof(AmbiguousSameShapeA.Take), BindingFlags.Public | BindingFlags.Static),
            typeof(AmbiguousSameShapeB).GetMethod(nameof(AmbiguousSameShapeB.Take), BindingFlags.Public | BindingFlags.Static),
        };
        var result = OverloadResolution.Resolve(all, new[] { typeof(string) });
        Assert.Equal(OverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome);
    }

    private static IEnumerable<MethodInfo> ThreeWayCandidates()
    {
        yield return typeof(ThreeWayClass).GetMethod(nameof(ThreeWayClass.Choose), BindingFlags.Public | BindingFlags.Static);
        yield return typeof(ThreeWayStruct).GetMethod(nameof(ThreeWayStruct.Choose), BindingFlags.Public | BindingFlags.Static);
        yield return typeof(ThreeWayNone).GetMethod(nameof(ThreeWayNone.Choose), BindingFlags.Public | BindingFlags.Static);
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

        // Issue #321 fixture: optional trailing parameter on an open generic
        // method (mirrors JsonSerializer.Serialize<TValue>(TValue, options = null)).
        public static string G_SerializeLike<TValue>(TValue value, object options = null) => value?.ToString();

        // Issue #327: optional-parameter fixtures.
        public static void O_OneOptional(int a, System.Threading.CancellationToken token = default) { _ = a; _ = token; }

        public static void O_TwoOptional(int a, System.Threading.CancellationToken first = default, System.Threading.CancellationToken second = default) { _ = a; _ = first; _ = second; }

        public static void O_Required(int a, int b) { _ = a; _ = b; }

        // ADR-0055 Tier 4 (#369): fixtures for interpolated-string → formattable
        // applicability and tie-breaking.
        public static void F_String(string s) { _ = s; }

        public static void F_FormattableString(System.FormattableString fs) { _ = fs; }

        public static void F_IFormattable(System.IFormattable f) { _ = f; }
    }

    /// <summary>
    /// Issue #505: fixture that mirrors the xUnit
    /// <c>Assert.Equal</c>/<c>Assert.NotEqual</c> overload set responsible for
    /// the original ambiguous-overload diagnostic. The shape is deliberately
    /// representative: a generic two-parameter form, a generic three-parameter
    /// form with a comparer, a non-generic <c>(string, string)</c> form, and a
    /// non-generic <c>(string, string, ...)</c> form with trailing optionals.
    /// </summary>
    public static class EqualLike
    {
        public static void Equal<T>(T expected, T actual) { _ = expected; _ = actual; }

        public static void Equal<T>(T expected, T actual, System.Collections.Generic.IEqualityComparer<T> comparer) { _ = expected; _ = actual; _ = comparer; }

        public static void Equal(string expected, string actual) { _ = expected; _ = actual; }

        public static void Equal(string expected, string actual, bool ignoreCase = false, bool ignoreLineEndingDifferences = false, bool ignoreWhiteSpaceDifferences = false, bool ignoreAllWhiteSpace = false)
        {
            _ = expected;
            _ = actual;
            _ = ignoreCase;
            _ = ignoreLineEndingDifferences;
            _ = ignoreWhiteSpaceDifferences;
            _ = ignoreAllWhiteSpace;
        }

        public static void NotEqual<T>(T expected, T actual) { _ = expected; _ = actual; }

        public static void NotEqual(string expected, string actual) { _ = expected; _ = actual; }

        // Companion overloads referenced by Resolve_PrefersNonGenericOverGeneric_FromStringStringArgs
        // when it needs the two specific MethodInfo handles by name.
        public static void Equal_TT<T>(T expected, T actual) => Equal(expected, actual);

        public static void Equal_StringString(string expected, string actual) => Equal(expected, actual);

        // Truly-ambiguous case: two non-generic overloads taking unrelated
        // interfaces. A receiver implementing both leaves the resolver unable
        // to pick a single best candidate.
        public interface IA
        {
        }

        public interface IB
        {
        }

        public sealed class BothAB : IA, IB
        {
        }

        public static void Take_IA(IA a) { _ = a; }

        public static void Take_IB(IB b) { _ = b; }
    }

    // ----- Issue #750 / ADR-0088 fixtures -----
    //
    // C# does not allow two methods in the same class to differ only by
    // generic constraint (CS0111 — constraints are not part of the signature).
    // The fixtures below split candidates across companion classes so the
    // resolver still sees the same name from multiple sources, mirroring how
    // the binder enumerates extension methods.

    public static class ConstraintFixture
    {
        public static void OnlyClass<T>(T x)
            where T : class
        {
            _ = x;
        }

        public static void OnlyStruct<T>(T x)
            where T : struct
        {
            _ = x;
        }

        public static void OnlyNew<T>()
            where T : new()
        {
        }
    }

    public static class MapLike
    {
        // Reference-typed receiver: `T? self` with `where T : class` lowers to
        // a bare `T` parameter at the IL level (nullable annotation only).
        public static U Map<T, U>(T self, Func<T, U> f)
            where T : class
            where U : class
        {
            return self is null ? null : f(self);
        }

        // Value-typed receiver: `T? self` with `where T : struct` lowers to
        // a `Nullable<T>` parameter at the IL level. This is the only shape
        // axis C# can overload on, so today both overloads coexist — but the
        // G# binder used to drop the constraint check and pick the wrong one
        // when the receiver type was a Nullable<value-type>.
        public static U? Map<T, U>(T? self, Func<T, U> f)
            where T : struct
            where U : struct
        {
            return self.HasValue ? f(self.Value) : default(U?);
        }
    }

    public static class ThreeWayClass
    {
        public static string Choose<T>(T x)
            where T : class
        {
            _ = x;
            return "class";
        }
    }

    public static class ThreeWayStruct
    {
        public static string Choose<T>(T x)
            where T : struct
        {
            _ = x;
            return "struct";
        }
    }

    public static class ThreeWayNone
    {
        public static string Choose<T>(T x)
        {
            _ = x;
            return "none";
        }
    }

    public static class AmbiguousSameShapeA
    {
        public static void Take<T>(T x)
            where T : class
        {
            _ = x;
        }
    }

    public static class AmbiguousSameShapeB
    {
        public static void Take<T>(T x)
            where T : class
        {
            _ = x;
        }
    }
}
