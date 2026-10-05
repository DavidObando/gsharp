// <copyright file="OverloadResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Stream F: pure unit tests for <see cref="ClrOverloadResolution"/> focused on
/// numeric "better conversion target" tie-breaking (C# §7.5.3.4). Builds tiny
/// fixture method sets via reflection so we can drive the resolver directly
/// without going through the binder.
/// </summary>
public class OverloadResolutionTests
{
    [Fact]
    public void Resolve_PrefersIdentityOverWidening()
    {
        var resolved = Resolve("F_Int_Long", "F_Long_Long", new[] { typeof(int), typeof(long) });
        Assert.Equal("F_Int_Long", resolved.Name);
    }

    [Fact]
    public void Resolve_PrefersSmallerNumericTarget_LongOverFloat()
    {
        // int → long is implicit and long → float is implicit, so long is a
        // better conversion target than float per C# §7.5.3.4.
        var resolved = Resolve("F_Long", "F_Float", new[] { typeof(int) });
        Assert.Equal("F_Long", resolved.Name);
    }

    [Fact]
    public void Resolve_PrefersSmallerNumericTarget_IntOverDouble()
    {
        // short → int is implicit and int → double is implicit, so int beats
        // double when binding a short argument.
        var resolved = Resolve("F_Int", "F_Double", new[] { typeof(short) });
        Assert.Equal("F_Int", resolved.Name);
    }

    [Fact]
    public void Resolve_PrefersSignedOverUnsigned_IntBeatsUInt()
    {
        // From a short argument, neither int→uint nor uint→int is implicit.
        // The signed/unsigned subclause of §7.5.3.4 picks the signed target.
        var resolved = Resolve("F_Int", "F_UInt", new[] { typeof(short) });
        Assert.Equal("F_Int", resolved.Name);
    }

    [Fact]
    public void Resolve_AmbiguousWhenNeitherNumericTargetDominates()
    {
        // From an int argument, neither float→decimal nor decimal→float is
        // implicit, and neither type appears in the signed-vs-unsigned table,
        // so the two widenings tie and the resolver reports ambiguity.
        var first = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_Float", BindingFlags.Public | BindingFlags.Static);
        var second = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_Decimal", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { first, second }, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome);
    }

    [Fact]
    public void Resolve_CollapsesInterchangeableDuplicateCandidates()
    {
        // The full NuGet transitive closure can surface the exact same method
        // twice (e.g. MemoryExtensions.AsSpan reachable via System.Memory and
        // via a type-forwarding facade). Such duplicates share an identical
        // declaring type, name, generic arity, and parameter types, so they
        // must collapse to a single representative rather than being reported
        // as a spurious ambiguity.
        var method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_Int", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(method);
        var result = ClrOverloadResolution.Resolve(new[] { method, method }, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("F_Int", result.Best.Name);
    }

    [Fact]
    public void Resolve_TieBreakAppliesPerArgument()
    {
        // (int, int) args; pick F_Long_Long over F_Float_Float for both args.
        var resolved = Resolve(
            "F_Long_Long",
            "F_Float_Float",
            new[] { typeof(int), typeof(int) });
        Assert.Equal("F_Long_Long", resolved.Name);
    }

    [Fact]
    public void CompareNumericTargets_LongBeatsFloatFromInt()
    {
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(long), typeof(float), typeof(int)) < 0);
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(float), typeof(long), typeof(int)) > 0);
    }

    [Fact]
    public void CompareNumericTargets_IntBeatsUIntFromShort()
    {
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(int), typeof(uint), typeof(short)) < 0);
    }

    [Fact]
    public void CompareNumericTargets_EqualTargetsCompareZero()
    {
        Assert.Equal(0, ClrOverloadResolution.CompareNumericTargets(typeof(int), typeof(int), typeof(short)));
    }

    [Fact]
    public void InferTypeArguments_Identity_BindsTFromArgument()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Identity", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(string) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(string) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_PairWithConsistentBounds_Succeeds()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(int) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_PairWithConflictingBounds_Fails()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(string) }, out var typeArgs);
        Assert.False(ok);
        Assert.Null(typeArgs);
    }

    [Fact]
    public void InferTypeArguments_TwoParam_BindsBothIndependently()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_TwoParam", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(string) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int), typeof(string) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Array_UnwrapsElementType()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Array", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(int[]) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Enumerable_FromList_WalksInterface()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(System.Collections.Generic.List<int>) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Enumerable_FromArray_WalksInterface()
    {
        // #611: an array `int[]` implements IEnumerable<int>; the inference
        // should walk interfaces and find T = int.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(int[]) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Enumerable_FromStringArray_WalksInterface()
    {
        // #611: string[] → IEnumerable<string> inference.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(string[]) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(string) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Dictionary_BindsBothKeyAndValue()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_DictionaryFromValues", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(
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
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality), typeof(Quality?) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality?) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_NullableEnumAndNonNullable_PromotesToNullable()
    {
        // Issue #661: symmetric — G_Pair<T>(T, T) with (Quality?, Quality) must infer T = Quality?
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality?), typeof(Quality) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality?) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_BothNullableEnum_InfersNullable()
    {
        // Both operands nullable — should infer T = Quality? trivially.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality?), typeof(Quality?) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality?) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_BothNonNullableEnum_InfersNonNullable()
    {
        // Both non-nullable — should infer T = Quality.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(Quality), typeof(Quality) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(Quality) }, typeArgs);
    }

    [Fact]
    public void InferTypeArguments_Pair_NonNullableAndNullableInt_PromotesToNullable()
    {
        // Regression guard: the int case must still work.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var ok = ClrOverloadResolution.TryInferTypeArguments(open, new[] { typeof(int), typeof(int?) }, out var typeArgs);
        Assert.True(ok);
        Assert.Equal(new[] { typeof(int?) }, typeArgs);
    }

    [Fact]
    public void Resolve_EqualLike_NonNullableEnumAndNullableEnum_Resolves()
    {
        // Issue #661: Assert.Equal(Quality.High, actual) where actual : Quality?
        var candidates = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal");
        var result = ClrOverloadResolution.Resolve(candidates, new[] { typeof(Quality), typeof(Quality?) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(Quality?), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_EqualLike_NullableEnumAndNonNullableEnum_Resolves()
    {
        // Issue #661: symmetric case.
        var candidates = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal");
        var result = ClrOverloadResolution.Resolve(candidates, new[] { typeof(Quality?), typeof(Quality) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
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
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(int), typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethodDefinition);
        Assert.Equal(typeof(int), result.Best.GetGenericArguments()[0]);
        Assert.Equal(typeof(System.Collections.Generic.IEnumerable<int>), result.Best.ReturnType);
    }

    [Fact]
    public void Resolve_DropsOpenGenericWhenInferenceFails()
    {
        // G_Pair<T>(T, T) called with (int, string) cannot infer T — the
        // candidate must be dropped silently (NoneApplicable, not Ambiguous).
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(int), typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_ClosesGenericMethodWithOptionalTrailingParameter_FromInference()
    {
        // Issue #321: this mirrors JsonSerializer.Serialize<TValue>(TValue value,
        // JsonSerializerOptions? options = null). Passing a single (string)
        // argument must infer TValue = string and close the method even though
        // the declared arity is 2 with a trailing optional parameter.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_SerializeLike", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
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
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Identity", BindingFlags.Public | BindingFlags.Static);
        var seen = new System.Collections.Generic.List<Type>();
        Type Project(Type t)
        {
            seen.Add(t);
            return t;
        }

        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(string) }, explicitTypeArgs: null, projectTypeArgument: Project);
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(typeof(string), result.Best.GetGenericArguments()[0]);
        Assert.Contains(typeof(string), seen);
    }

    [Fact]
    public void Resolve_OmitsTrailingOptionalParameter()
    {
        // Issue #327: O_OneOptional(int, CancellationToken = default) is
        // applicable when called with a single int argument; the optional
        // trailing parameter is omitted. Mirrors HttpResponse.WriteAsync(text).
        var method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("O_OneOptional", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { method }, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("O_OneOptional", result.Best.Name);
    }

    [Fact]
    public void Resolve_OmitsTrailingOptionalParameter_StillAppliesWithAllArgs()
    {
        // The same candidate is still applicable when the optional argument is
        // supplied explicitly.
        var method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("O_OneOptional", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { method }, new[] { typeof(int), typeof(System.Threading.CancellationToken) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
    }

    [Fact]
    public void Resolve_RejectsCandidateWithNonOptionalMissingParameter()
    {
        // O_Required(int, int) has no optional parameters; calling with a single
        // argument leaves a non-optional parameter unfilled and is not applicable.
        var method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("O_Required", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { method }, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_PrefersFewerParametersWhenOptionalsTie()
    {
        // Issue #327: O_OneOptional(int, CancellationToken = default) and
        // O_TwoOptional(int, CancellationToken = default, CancellationToken =
        // default) both apply to a single int argument. The overload requiring
        // fewer omitted optionals wins (C# §7.5.3.2).
        var oneOpt = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("O_OneOptional", BindingFlags.Public | BindingFlags.Static);
        var twoOpt = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("O_TwoOptional", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { oneOpt, twoOpt }, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("O_OneOptional", result.Best.Name);
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
        var result = ClrOverloadResolution.Resolve(
            new[] { open },
            new[] { typeof(System.Collections.Generic.IEnumerable<int>), typeof(Func<int, int>) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.Best.IsGenericMethodDefinition);
    }

    private static MethodInfo Resolve(string a, string b, Type[] argTypes)
    {
        var first = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod(a, BindingFlags.Public | BindingFlags.Static);
        var second = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod(b, BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(first);
        Assert.NotNull(second);
        var result = ClrOverloadResolution.Resolve(new[] { first, second }, argTypes);
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        return result.Best;
    }

    [Fact]
    public void Resolve_TaskReturningLambda_PrefersFuncOfTaskOverload()
    {
        // Issue #2172: a task-returning lambda argument (natural type
        // Func<Task<object>>) is applicable to BOTH Run(Func<TResult>)
        // (TResult = Task<object>) and Run(Func<Task<TResult>>)
        // (TResult = object) as identity conversions. The betterness rule must
        // pick the Func<Task<TResult>> overload so the whole task binds to
        // Task<TResult>, matching C#'s preference for the task-returning
        // delegate overload for an async lambda.
        var funcTResult = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("Run_FuncTResult", BindingFlags.Public | BindingFlags.Static);
        var funcTaskTResult = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("Run_FuncTaskTResult", BindingFlags.Public | BindingFlags.Static);
        var argType = typeof(System.Func<System.Threading.Tasks.Task<object>>);

        // Candidate order must not matter — both orderings resolve to the
        // Func<Task<TResult>> overload without ambiguity.
        var forward = ClrOverloadResolution.Resolve(new[] { funcTResult, funcTaskTResult }, new[] { argType });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, forward.Outcome);
        Assert.Equal("Run_FuncTaskTResult", forward.Best.Name);

        var reverse = ClrOverloadResolution.Resolve(new[] { funcTaskTResult, funcTResult }, new[] { argType });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, reverse.Outcome);
        Assert.Equal("Run_FuncTaskTResult", reverse.Best.Name);

        // The winning overload closes over TResult = object, so its return type
        // is Task<object>, NOT Task<Task<object>>.
        var closedReturn = forward.Best.ReturnType;
        Assert.True(closedReturn.IsGenericType);
        Assert.True(ClrTypeInspector.IsSameAs(
            closedReturn.GetGenericTypeDefinition(),
            typeof(System.Threading.Tasks.Task<>)));
        Assert.Equal(typeof(object), closedReturn.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_NonTaskLambda_KeepsFuncOfTResultOverload()
    {
        // Guard: a NON-task-returning lambda argument (natural type
        // Func<object>) must NOT be pulled onto the Func<Task<TResult>>
        // overload — only the Func<TResult> overload applies, so the new
        // betterness rule must leave this case untouched.
        var funcTResult = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("Run_FuncTResult", BindingFlags.Public | BindingFlags.Static);
        var funcTaskTResult = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("Run_FuncTaskTResult", BindingFlags.Public | BindingFlags.Static);
        var argType = typeof(System.Func<object>);

        var result = ClrOverloadResolution.Resolve(new[] { funcTResult, funcTaskTResult }, new[] { argType });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("Run_FuncTResult", result.Best.Name);
    }

    [Fact]
    public void Resolve_InterpolatedStringPrefersStringOverFormattable()
    {
        // ADR-0055 Tier 4 (#369): an interpolated-string argument keeps its
        // natural `string` type for applicability, so the `string` overload (an
        // identity conversion) beats the `FormattableString` overload.
        var stringOverload = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_String", BindingFlags.Public | BindingFlags.Static);
        var formattableOverload = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(
            new[] { stringOverload, formattableOverload },
            new[] { typeof(string) },
            interpolatedStringArgs: new[] { true });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("F_String", result.Best.Name);
    }

    [Fact]
    public void Resolve_InterpolatedStringIsApplicableToFormattableOnlyOverload()
    {
        // With only a FormattableString overload, the flagged interpolated-string
        // argument is applicable thanks to the Tier 4 relaxation.
        var formattableOverload = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(
            new[] { formattableOverload },
            new[] { typeof(string) },
            interpolatedStringArgs: new[] { true });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("F_FormattableString", result.Best.Name);
    }

    [Fact]
    public void Resolve_PlainStringIsNotApplicableToFormattableOverload()
    {
        // Regression guard: without the interpolated-string flag a plain `string`
        // argument must NOT convert to FormattableString, so the overload is not
        // applicable. This keeps ordinary string arguments unaffected.
        var formattableOverload = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(
            new[] { formattableOverload },
            new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_InterpolatedStringPrefersFormattableStringOverIFormattable()
    {
        // FormattableString implements IFormattable, so it is the more specific
        // (better) target when both overloads apply to an interpolated string.
        var formattableOverload = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static);
        var iformattableOverload = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_IFormattable", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(
            new[] { iformattableOverload, formattableOverload },
            new[] { typeof(string) },
            interpolatedStringArgs: new[] { true });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("F_FormattableString", result.Best.Name);
    }

    [Fact]
    public void IsFormattableStringTarget_RecognizesFormattableTargets()
    {
        Assert.True(ClrOverloadResolution.IsFormattableStringTarget(typeof(System.FormattableString)));
        Assert.True(ClrOverloadResolution.IsFormattableStringTarget(typeof(System.IFormattable)));
        Assert.False(ClrOverloadResolution.IsFormattableStringTarget(typeof(string)));
        Assert.False(ClrOverloadResolution.IsFormattableStringTarget(typeof(object)));
        Assert.False(ClrOverloadResolution.IsFormattableStringTarget(null));
    }

    [Fact]
    public void Resolve_PrefersNonGenericOverGeneric_FromStringStringArgs()
    {
        // Issue #505: mirrors xUnit's Assert.Equal(string, string) (non-generic)
        // vs Assert.Equal<T>(T, T) (generic). Both apply to (string, string) with
        // identity conversions, but per C# §7.5.3.2 the non-generic overload is
        // preferred. Without this tie-break, users had to write `Equal[string]`.
        var nonGeneric = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Equal_StringString", BindingFlags.Public | BindingFlags.Static);
        var generic = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Equal_TT", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(
            new[] { generic, nonGeneric },
            new[] { typeof(string), typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal("Equal_StringString", result.Best.Name);
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
        var candidates = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal" || m.Name.StartsWith("Equal_", StringComparison.Ordinal))
            .ToList();

        // Sanity: the fixture should include several overloads otherwise the
        // test is not actually exercising the disambiguation pass.
        Assert.True(candidates.Count >= 4, "expected a multi-overload fixture");

        // Pass them in via the synthesized `Equal` name on a real CLR Equal
        // probe class so this exercises the same EvaluateCandidate path.
        var nameMatches = candidates.Where(m => m.Name == "Equal").ToList();
        var result = ClrOverloadResolution.Resolve(nameMatches, new[] { typeof(string), typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
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
        var generic = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Equal_TT", BindingFlags.Public | BindingFlags.Static);
        var nonGeneric = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Equal_StringString", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(
            new[] { generic, nonGeneric },
            new[] { typeof(string), typeof(string) },
            explicitTypeArgs: new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
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
        var candidates = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Equal")
            .ToList();
        var result = ClrOverloadResolution.Resolve(candidates, new[] { typeof(int), typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.True(result.Best.IsGenericMethod);
        Assert.Equal(typeof(int), result.Best.GetGenericArguments()[0]);
    }

    [Fact]
    public void Resolve_InferableGenericNotEqual_FromTwoStringArgs_PicksNonGeneric()
    {
        // Issue #505 companion: same reasoning for NotEqual. Non-generic
        // NotEqual(string, string) wins over generic NotEqual<T>(T, T).
        var candidates = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "NotEqual")
            .ToList();
        var result = ClrOverloadResolution.Resolve(candidates, new[] { typeof(string), typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
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
        var first = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Take_IA", BindingFlags.Public | BindingFlags.Static);
        var second = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Take_IB", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { first, second }, new[] { NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+BothAB") });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome);
        Assert.Equal(2, result.Ambiguous.Length);
        var signatures = result.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature).ToArray();
        Assert.Contains(signatures, s => s.Contains("IA"));
        Assert.Contains(signatures, s => s.Contains("IB"));
    }

    [Fact]
    public void FormatMethodSignature_FormatsGenericMethod_WithBracketedTypeArgs()
    {
        // Issue #505: the diagnostic helper must surface a readable signature
        // including the closed generic type arguments.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Identity", BindingFlags.Public | BindingFlags.Static);
        var closed = open.MakeGenericMethod(typeof(string));
        var formatted = ClrOverloadResolution.FormatMethodSignature(closed);
        Assert.Equal("G_Identity[String](String)", formatted);
    }

    [Fact]
    public void FormatMethodSignature_FormatsNonGenericMethod_PlainParens()
    {
        var method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("F_Int", BindingFlags.Public | BindingFlags.Static);
        var formatted = ClrOverloadResolution.FormatMethodSignature(method);
        Assert.Equal("F_Int(Int32)", formatted);
    }

    [Fact]
    public void FormatMethodSignature_FormatsGenericTypeArguments_InParameters()
    {
        // Generic parameter types like IEnumerable<T> should be rendered with
        // bracketed arguments rather than mangled (`IEnumerable`1`) names.
        var method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture").GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static);
        var closed = method.MakeGenericMethod(typeof(int));
        var formatted = ClrOverloadResolution.FormatMethodSignature(closed);
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
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture").GetMethod("OnlyClass", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DropsCandidate_WhenStructConstraintViolatedByReferenceType()
    {
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture").GetMethod("OnlyStruct", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DropsCandidate_WhenStructConstraintViolatedByNullableValueType()
    {
        // `where T : struct` rejects Nullable<T> — int? is not a "non-nullable
        // value type" per ECMA-335.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture").GetMethod("OnlyStruct", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(int?) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DropsCandidate_WhenNewConstraintViolated()
    {
        // ConstraintFixture.OnlyNew<T>() where T : new() — string has no
        // public parameterless ctor.
        var open = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture").GetMethod("OnlyNew", BindingFlags.Public | BindingFlags.Static);
        var result = ClrOverloadResolution.Resolve(new[] { open }, new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome);
    }

    [Fact]
    public void Resolve_DisjointClassStructOverloads_PicksClassForReferenceType()
    {
        // The repro from issue #750: two extensions with identical parameter
        // shape (modulo the receiver), disjoint class/struct constraints. The
        // binder must pick the class overload when called with a string.
        var both = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+MapLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Map");
        var result = ClrOverloadResolution.Resolve(both, new[] { typeof(string), typeof(Func<string, string>) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        // Class overload's T resolves to string; struct overload couldn't infer
        // T at all from a string receiver.
        Assert.Equal(typeof(string), result.Best.GetGenericArguments()[0]);
        Assert.Equal(NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+MapLike"), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_DisjointClassStructOverloads_PicksStructForNullableValueType()
    {
        var both = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+MapLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "Map");
        var result = ClrOverloadResolution.Resolve(both, new[] { typeof(int?), typeof(Func<int, int>) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
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
        var result = ClrOverloadResolution.Resolve(all, new[] { typeof(int) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayStruct"), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_ThreeWayConstraints_PrefersClassOverNone_ForReferenceArgument()
    {
        var all = ThreeWayCandidates();
        var result = ClrOverloadResolution.Resolve(all, new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayClass"), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_FallsThroughToUnconstrained_WhenConstrainedCandidatesFail()
    {
        // Receiver is Nullable<int> — neither class (because Nullable<T> is a
        // value type) nor struct (because the struct constraint excludes
        // Nullable<T>) applies. The unconstrained overload survives and wins.
        var all = ThreeWayCandidates();
        var result = ClrOverloadResolution.Resolve(all, new[] { typeof(int?) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.Equal(NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayNone"), result.Best.DeclaringType);
    }

    [Fact]
    public void Resolve_SameSpecificityOverloads_ReportsAmbiguity()
    {
        // Two overloads with identical constraints from disjoint declaring
        // classes cannot be disambiguated by the new constraint-specificity
        // tie-break; the existing ambiguity diagnostic fires.
        var all = new[]
        {
            NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeA").GetMethod("Take", BindingFlags.Public | BindingFlags.Static),
            NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeB").GetMethod("Take", BindingFlags.Public | BindingFlags.Static),
        };
        var result = ClrOverloadResolution.Resolve(all, new[] { typeof(string) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome);
    }

    // ----- Issue #1634: supplementaryInterfaceCheck / constantNarrowingArgumentCheck
    // must be per-call parameters, not shared mutable state, so that concurrent
    // and nested (reentrant) `Resolve<T>` calls never observe each other's hook. -----

    [Fact]
    public async System.Threading.Tasks.Task Resolve_SupplementaryInterfaceCheck_IsIsolatedAcrossConcurrentCalls()
    {
        // Two disjoint interface targets, both applicable only through a
        // per-call supplementaryInterfaceCheck (the `object`-typed argument
        // stands in for a user-class surrogate CLR type, mirroring issue
        // #658). Hammer Resolve<T> from many threads at once, each thread
        // consistently requesting ONE of the two targets: if the hooks were
        // still shared static state, some iterations would race and resolve
        // to the wrong candidate (or throw NullReferenceException from a
        // hook nulled out mid-flight by another thread).
        var takeIA = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Take_IA", BindingFlags.Public | BindingFlags.Static);
        var takeIB = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Take_IB", BindingFlags.Public | BindingFlags.Static);
        var candidates = new[] { takeIA, takeIB };

        void RunFor(Type wantInterface, string expectedName, int iterations, List<Exception> errors)
        {
            for (var i = 0; i < iterations; i++)
            {
                try
                {
                    var result = ClrOverloadResolution.Resolve(
                        candidates,
                        new[] { typeof(object) },
                        supplementaryInterfaceCheck: (source, target) => target == wantInterface);
                    if (result.Outcome != ClrOverloadResolution.ResolutionOutcome.Resolved
                        || result.Best.Name != expectedName)
                    {
                        lock (errors)
                        {
                            errors.Add(new Exception($"Expected {expectedName} for {wantInterface}, got {result.Outcome}/{result.Best?.Name}"));
                        }
                    }
                }
                catch (Exception ex)
                {
                    lock (errors)
                    {
                        errors.Add(ex);
                    }
                }
            }
        }

        var errors = new List<Exception>();
        const int iterations = 500;
        var taskA = System.Threading.Tasks.Task.Run(() => RunFor(NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IA"), "Take_IA", iterations, errors));
        var taskB = System.Threading.Tasks.Task.Run(() => RunFor(NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IB"), "Take_IB", iterations, errors));
        await System.Threading.Tasks.Task.WhenAll(taskA, taskB);

        Assert.Empty(errors);
    }

    [Fact]
    public void Resolve_SupplementaryInterfaceCheck_SurvivesNestedResolveInsideHookCallback()
    {
        // Reentrancy guard: a supplementaryInterfaceCheck callback that itself
        // triggers a nested Resolve<T> call (mirroring RebindInlineOutVarArguments
        // / lambda re-binding running "inside the hook window" per issue #1634)
        // must not corrupt the outer call's own hook. With hooks threaded as
        // parameters instead of mutable statics, the outer closure is captured
        // by value and is unaffected by whatever the nested call does.
        var takeIA = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Take_IA", BindingFlags.Public | BindingFlags.Static);
        var takeIB = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike").GetMethod("Take_IB", BindingFlags.Public | BindingFlags.Static);
        var candidates = new[] { takeIA, takeIB };

        var nestedCallCount = 0;
        var outerResult = ClrOverloadResolution.Resolve(
            candidates,
            new[] { typeof(object) },
            supplementaryInterfaceCheck: (source, target) =>
            {
                if (target == NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IA"))
                {
                    // Nested resolution, run from *inside* the outer hook,
                    // using a DIFFERENT hook that targets IB. Under the old
                    // "install -> Resolve -> finally null" static-field
                    // pattern this would null the outer's field once the
                    // nested call's finally ran, and any subsequent
                    // ClassifyImplicit probe of the outer call would silently
                    // stop recognising IA.
                    nestedCallCount++;
                    var nested = ClrOverloadResolution.Resolve(
                        candidates,
                        new[] { typeof(object) },
                        supplementaryInterfaceCheck: (nestedSource, nestedTarget) => nestedTarget == NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IB"));
                    Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, nested.Outcome);
                    Assert.Equal("Take_IB", nested.Best.Name);
                    return true;
                }

                return false;
            });

        Assert.True(nestedCallCount > 0);
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, outerResult.Outcome);
        Assert.Equal("Take_IA", outerResult.Best.Name);
    }

    private static IEnumerable<MethodInfo> ThreeWayCandidates()
    {
        yield return NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayClass").GetMethod("Choose", BindingFlags.Public | BindingFlags.Static);
        yield return NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayStruct").GetMethod("Choose", BindingFlags.Public | BindingFlags.Static);
        yield return NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayNone").GetMethod("Choose", BindingFlags.Public | BindingFlags.Static);
    }
}
