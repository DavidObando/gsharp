// <copyright file="OverloadResolutionTests.cs" company="GSharp">
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
import System.Threading
import System.Threading.Tasks
import Xunit

/// Stream F: pure unit tests for (cref:ClrOverloadResolution) focused on
/// numeric "better conversion target" tie-breaking (C# §7.5.3.4). Builds tiny
/// fixture method sets via reflection so we can drive the resolver directly
/// without going through the binder.
open class OverloadResolutionTests {
    @Fact
    func Resolve_PrefersIdentityOverWidening() {
        let resolved MethodInfo? = Resolve("F_Int_Long", "F_Long_Long", []Type{typeof(int32), typeof(int64)})
        Assert.Equal("F_Int_Long", resolved!!.Name)
    }

    @Fact
    func Resolve_PrefersSmallerNumericTarget_LongOverFloat() {
        // int → long is implicit and long → float is implicit, so long is a
        // better conversion target than float per C# §7.5.3.4.
        let resolved MethodInfo? = Resolve("F_Long", "F_Float", []Type{typeof(int32)})
        Assert.Equal("F_Long", resolved!!.Name)
    }

    @Fact
    func Resolve_PrefersSmallerNumericTarget_IntOverDouble() {
        // short → int is implicit and int → double is implicit, so int beats
        // double when binding a short argument.
        let resolved MethodInfo? = Resolve("F_Int", "F_Double", []Type{typeof(int16)})
        Assert.Equal("F_Int", resolved!!.Name)
    }

    @Fact
    func Resolve_PrefersSignedOverUnsigned_IntBeatsUInt() {
        // From a short argument, neither int→uint nor uint→int is implicit.
        // The signed/unsigned subclause of §7.5.3.4 picks the signed target.
        let resolved MethodInfo? = Resolve("F_Int", "F_UInt", []Type{typeof(int16)})
        Assert.Equal("F_Int", resolved!!.Name)
    }

    @Fact
    func Resolve_AmbiguousWhenNeitherNumericTargetDominates() {
        // From an int argument, neither float→decimal nor decimal→float is
        // implicit, and neither type appears in the signed-vs-unsigned table,
        // so the two widenings tie and the resolver reports ambiguity.
        let first MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_Float", BindingFlags.Public | BindingFlags.Static)
        let second MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_Decimal", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{first!!, second!!}, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome)
    }

    @Fact
    func Resolve_CollapsesInterchangeableDuplicateCandidates() {
        // The full NuGet transitive closure can surface the exact same method
        // twice (e.g. MemoryExtensions.AsSpan reachable via System.Memory and
        // via a type-forwarding facade). Such duplicates share an identical
        // declaring type, name, generic arity, and parameter types, so they
        // must collapse to a single representative rather than being reported
        // as a spurious ambiguity.
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_Int", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(method)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{method!!, method!!}, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("F_Int", result.Best!!.Name)
    }

    @Fact
    func Resolve_TieBreakAppliesPerArgument() {
        // (int, int) args; pick F_Long_Long over F_Float_Float for both args.
        let resolved MethodInfo? = Resolve("F_Long_Long", "F_Float_Float", []Type{typeof(int32), typeof(int32)})
        Assert.Equal("F_Long_Long", resolved!!.Name)
    }

    @Fact
    func CompareNumericTargets_LongBeatsFloatFromInt() {
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(int64), typeof(float32), typeof(int32)) < 0)
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(float32), typeof(int64), typeof(int32)) > 0)
    }

    @Fact
    func CompareNumericTargets_IntBeatsUIntFromShort() {
        Assert.True(ClrOverloadResolution.CompareNumericTargets(typeof(int32), typeof(uint32), typeof(int16)) < 0)
    }

    @Fact
    func CompareNumericTargets_EqualTargetsCompareZero() {
        Assert.Equal(0, ClrOverloadResolution.CompareNumericTargets(typeof(int32), typeof(int32), typeof(int16)))
    }

    @Fact
    func InferTypeArguments_Identity_BindsTFromArgument() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Identity", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(open_!!, []Type{typeof(string)}, out var typeArgs)
        Assert.True(ok)
        Assert.Equal([]Type{typeof(string)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_PairWithConsistentBounds_Succeeds() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(int32), typeof(int32)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(int32)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_PairWithConflictingBounds_Fails() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(int32), typeof(string)},
            out var typeArgs
        )
        Assert.False(ok)
        Assert.Null(typeArgs)
    }

    @Fact
    func InferTypeArguments_TwoParam_BindsBothIndependently() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_TwoParam", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(int32), typeof(string)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(int32), typeof(string)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Array_UnwrapsElementType() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Array", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(open_!!, []Type{typeof([]int32)}, out var typeArgs)
        Assert.True(ok)
        Assert.Equal([]Type{typeof(int32)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Enumerable_FromList_WalksInterface() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(open_!!, []Type{typeof(List[int32])}, out var typeArgs)
        Assert.True(ok)
        Assert.Equal([]Type{typeof(int32)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Enumerable_FromArray_WalksInterface() {
        // #611: an array `int[]` implements IEnumerable<int>; the inference
        // should walk interfaces and find T = int.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(open_!!, []Type{typeof([]int32)}, out var typeArgs)
        Assert.True(ok)
        Assert.Equal([]Type{typeof(int32)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Enumerable_FromStringArray_WalksInterface() {
        // #611: string[] → IEnumerable<string> inference.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(open_!!, []Type{typeof([]string)}, out var typeArgs)
        Assert.True(ok)
        Assert.Equal([]Type{typeof(string)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Dictionary_BindsBothKeyAndValue() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_DictionaryFromValues", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(Dictionary[string, int32])},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(string), typeof(int32)}, typeArgs)
    }

    // --- Issue #661: nullable-aware inference (T vs Nullable<T>) ---
    enum Quality {
        Low = 1,
        High
    }

    @Fact
    func InferTypeArguments_Pair_NonNullableAndNullableEnum_PromotesToNullable() {
        // Issue #661: G_Pair<T>(T, T) with (Quality, Quality?) must infer T = Quality?
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(Quality), typeof(Quality?)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(Quality?)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Pair_NullableEnumAndNonNullable_PromotesToNullable() {
        // Issue #661: symmetric — G_Pair<T>(T, T) with (Quality?, Quality) must infer T = Quality?
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(Quality?), typeof(Quality)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(Quality?)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Pair_BothNullableEnum_InfersNullable() {
        // Both operands nullable — should infer T = Quality? trivially.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(Quality?), typeof(Quality?)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(Quality?)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Pair_BothNonNullableEnum_InfersNonNullable() {
        // Both non-nullable — should infer T = Quality.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(Quality), typeof(Quality)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(Quality)}, typeArgs)
    }

    @Fact
    func InferTypeArguments_Pair_NonNullableAndNullableInt_PromotesToNullable() {
        // Regression guard: the int case must still work.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let ok = ClrOverloadResolution.TryInferTypeArguments(
            open_!!,
            []Type{typeof(int32), typeof(int32?)},
            out var typeArgs
        )
        Assert.True(ok)
        Assert.Equal([]Type{typeof(int32?)}, typeArgs)
    }

    @Fact
    func Resolve_EqualLike_NonNullableEnumAndNullableEnum_Resolves() {
        // Issue #661: Assert.Equal(Quality.High, actual) where actual : Quality?
        let candidates = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "Equal")
        let result = ClrOverloadResolution.Resolve(candidates, []Type{typeof(Quality), typeof(Quality?)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal(typeof(Quality?), result.Best!!.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_EqualLike_NullableEnumAndNonNullableEnum_Resolves() {
        // Issue #661: symmetric case.
        let candidates = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "Equal")
        let result = ClrOverloadResolution.Resolve(candidates, []Type{typeof(Quality?), typeof(Quality)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal(typeof(Quality?), result.Best!!.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_ClosesOpenGenericMethod_FromInferableArgs() {
        // Enumerable.Repeat<TResult>(TResult element, int count) is open
        // generic. Passing (int, int) should infer TResult = int and return
        // the closed MethodInfo with the correct return type.
        let open_ = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (m MethodInfo) -> m.Name == "Repeat" && m.IsGenericMethodDefinition
        )
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_}, []Type{typeof(int32), typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.False(result.Best!!.IsGenericMethodDefinition)
        Assert.Equal(typeof(int32), result.Best!!.GetGenericArguments()[0])
        Assert.Equal(typeof(IEnumerable[int32]), result.Best!!.ReturnType)
    }

    @Fact
    func Resolve_DropsOpenGenericWhenInferenceFails() {
        // G_Pair<T>(T, T) called with (int, string) cannot infer T — the
        // candidate must be dropped silently (NoneApplicable, not Ambiguous).
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Pair", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(int32), typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_ClosesGenericMethodWithOptionalTrailingParameter_FromInference() {
        // Issue #321: this mirrors JsonSerializer.Serialize<TValue>(TValue value,
        // JsonSerializerOptions? options = null). Passing a single (string)
        // argument must infer TValue = string and close the method even though
        // the declared arity is 2 with a trailing optional parameter.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_SerializeLike", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.False(result.Best!!.IsGenericMethodDefinition)
        Assert.Equal(typeof(string), result.Best!!.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_ProjectsInferredTypeArgument_BeforeClosingGenericMethod() {
        // Issue #321: inferred type arguments are live host-runtime Type objects.
        // When the candidate was loaded under a different context, they must be
        // projected before MakeGenericMethod. Verify the projection callback is
        // invoked for the inferred argument and that its result is honored.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Identity", BindingFlags.Public | BindingFlags.Static)
        let seen = List[Type]()
        let Project = func (t Type) Type {
            seen.Add(t)
            return t
        }
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{open_!!},
            []Type{typeof(string)},
            explicitTypeArgs: nil,
            projectTypeArgument: Project
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal(typeof(string), result.Best!!.GetGenericArguments()[0])
        Assert.Contains(typeof(string), seen)
    }

    @Fact
    func Resolve_OmitsTrailingOptionalParameter() {
        // Issue #327: O_OneOptional(int, CancellationToken = default) is
        // applicable when called with a single int argument; the optional
        // trailing parameter is omitted. Mirrors HttpResponse.WriteAsync(text).
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("O_OneOptional", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{method!!}, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("O_OneOptional", result.Best!!.Name)
    }

    @Fact
    func Resolve_OmitsTrailingOptionalParameter_StillAppliesWithAllArgs() {
        // The same candidate is still applicable when the optional argument is
        // supplied explicitly.
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("O_OneOptional", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{method!!},
            []Type{typeof(int32), typeof(CancellationToken)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
    }

    @Fact
    func Resolve_RejectsCandidateWithNonOptionalMissingParameter() {
        // O_Required(int, int) has no optional parameters; calling with a single
        // argument leaves a non-optional parameter unfilled and is not applicable.
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("O_Required", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{method!!}, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_PrefersFewerParametersWhenOptionalsTie() {
        // Issue #327: O_OneOptional(int, CancellationToken = default) and
        // O_TwoOptional(int, CancellationToken = default, CancellationToken =
        // default) both apply to a single int argument. The overload requiring
        // fewer omitted optionals wins (C# §7.5.3.2).
        let oneOpt MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("O_OneOptional", BindingFlags.Public | BindingFlags.Static)
        let twoOpt MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("O_TwoOptional", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{oneOpt!!, twoOpt!!}, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("O_OneOptional", result.Best!!.Name)
    }

    @Fact
    func Resolve_OmitsTrailingOptionalParameter_OnOpenGenericMethod() {
        // Issue #327: Enumerable.CountBy<TSource,TKey>(IEnumerable<TSource>,
        // Func<TSource,TKey>, IEqualityComparer<TKey> = null) is open generic
        // with a trailing optional. Inference must succeed from the first two
        // arguments while the optional comparer is omitted.
        let open_ = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static).Single(
            (m MethodInfo) -> m.Name == "CountBy" && m.IsGenericMethodDefinition
        )
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{open_},
            []Type{typeof(IEnumerable[int32]), typeof((int32) -> int32)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.False(result.Best!!.IsGenericMethodDefinition)
    }

    @Fact
    func Resolve_TaskReturningLambda_PrefersFuncOfTaskOverload() {
        // Issue #2172: a task-returning lambda argument (natural type
        // Func<Task<object>>) is applicable to BOTH Run(Func<TResult>)
        // (TResult = Task<object>) and Run(Func<Task<TResult>>)
        // (TResult = object) as identity conversions. The betterness rule must
        // pick the Func<Task<TResult>> overload so the whole task binds to
        // Task<TResult>, matching C#'s preference for the task-returning
        // delegate overload for an async lambda.
        let funcTResult MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("Run_FuncTResult", BindingFlags.Public | BindingFlags.Static)
        let funcTaskTResult MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("Run_FuncTaskTResult", BindingFlags.Public | BindingFlags.Static)
        let argType = typeof(async () -> object)
        // Candidate order must not matter — both orderings resolve to the
        // Func<Task<TResult>> overload without ambiguity.
        let forward = ClrOverloadResolution.Resolve([]MethodInfo{funcTResult!!, funcTaskTResult!!}, []Type{argType})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, forward.Outcome)
        Assert.Equal("Run_FuncTaskTResult", forward.Best!!.Name)
        let reverse = ClrOverloadResolution.Resolve([]MethodInfo{funcTaskTResult!!, funcTResult!!}, []Type{argType})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, reverse.Outcome)
        Assert.Equal("Run_FuncTaskTResult", reverse.Best!!.Name)
        // The winning overload closes over TResult = object, so its return type
        // is Task<object>, NOT Task<Task<object>>.
        let closedReturn = forward.Best!!.ReturnType
        Assert.True(closedReturn.IsGenericType)
        Assert.True(
            ClrTypeInspector.IsSameAs(closedReturn.GetGenericTypeDefinition(), typeof(System.Threading.Tasks.Task[_]))
        )
        Assert.Equal(typeof(object), closedReturn.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_NonTaskLambda_KeepsFuncOfTResultOverload() {
        // Guard: a NON-task-returning lambda argument (natural type
        // Func<object>) must NOT be pulled onto the Func<Task<TResult>>
        // overload — only the Func<TResult> overload applies, so the new
        // betterness rule must leave this case untouched.
        let funcTResult MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("Run_FuncTResult", BindingFlags.Public | BindingFlags.Static)
        let funcTaskTResult MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("Run_FuncTaskTResult", BindingFlags.Public | BindingFlags.Static)
        let argType = typeof(() -> object)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{funcTResult!!, funcTaskTResult!!}, []Type{argType})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("Run_FuncTResult", result.Best!!.Name)
    }

    @Fact
    func Resolve_InterpolatedStringPrefersStringOverFormattable() {
        // ADR-0055 Tier 4 (#369): an interpolated-string argument keeps its
        // natural `string` type for applicability, so the `string` overload (an
        // identity conversion) beats the `FormattableString` overload.
        let stringOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_String", BindingFlags.Public | BindingFlags.Static)
        let formattableOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{stringOverload!!, formattableOverload!!},
            []Type{typeof(string)},
            interpolatedStringArgs: []bool{true}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("F_String", result.Best!!.Name)
    }

    @Fact
    func Resolve_InterpolatedStringIsApplicableToFormattableOnlyOverload() {
        // With only a FormattableString overload, the flagged interpolated-string
        // argument is applicable thanks to the Tier 4 relaxation.
        let formattableOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{formattableOverload!!},
            []Type{typeof(string)},
            interpolatedStringArgs: []bool{true}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("F_FormattableString", result.Best!!.Name)
    }

    @Fact
    func Resolve_PlainStringIsNotApplicableToFormattableOverload() {
        // Regression guard: without the interpolated-string flag a plain `string`
        // argument must NOT convert to FormattableString, so the overload is not
        // applicable. This keeps ordinary string arguments unaffected.
        let formattableOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{formattableOverload!!}, []Type{typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_InterpolatedStringPrefersFormattableStringOverIFormattable() {
        // FormattableString implements IFormattable, so it is the more specific
        // (better) target when both overloads apply to an interpolated string.
        let formattableOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_FormattableString", BindingFlags.Public | BindingFlags.Static)
        let iformattableOverload MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_IFormattable", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{iformattableOverload!!, formattableOverload!!},
            []Type{typeof(string)},
            interpolatedStringArgs: []bool{true}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("F_FormattableString", result.Best!!.Name)
    }

    @Fact
    func IsFormattableStringTarget_RecognizesFormattableTargets() {
        Assert.True(ClrOverloadResolution.IsFormattableStringTarget(typeof(FormattableString)))
        Assert.True(ClrOverloadResolution.IsFormattableStringTarget(typeof(IFormattable)))
        Assert.False(ClrOverloadResolution.IsFormattableStringTarget(typeof(string)))
        Assert.False(ClrOverloadResolution.IsFormattableStringTarget(typeof(object)))
        Assert.False(ClrOverloadResolution.IsFormattableStringTarget(nil))
    }

    @Fact
    func Resolve_PrefersNonGenericOverGeneric_FromStringStringArgs() {
        // Issue #505: mirrors xUnit's Assert.Equal(string, string) (non-generic)
        // vs Assert.Equal<T>(T, T) (generic). Both apply to (string, string) with
        // identity conversions, but per C# §7.5.3.2 the non-generic overload is
        // preferred. Without this tie-break, users had to write `Equal[string]`.
        let nonGeneric MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Equal_StringString", BindingFlags.Public | BindingFlags.Static)
        let generic MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Equal_TT", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{generic!!, nonGeneric!!},
            []Type{typeof(string), typeof(string)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal("Equal_StringString", result.Best!!.Name)
        Assert.False(result.Best!!.IsGenericMethod)
    }

    @Fact
    func Resolve_PrefersNonGenericOverGeneric_AcrossFullEqualOverloadSet() {
        // Issue #505: full reproduction with the family of xUnit-style Equal
        // overloads — non-generic Equal(string, string), generic Equal<T>(T, T),
        // generic Equal<T>(T, T, IEqualityComparer<T>), and string/comparison
        // overloads that take extra optional trailing booleans. (string, string)
        // resolves uniquely to the non-generic Equal(string, string).
        let candidates = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "Equal" || m.Name.StartsWith("Equal_", StringComparison.Ordinal))
            .ToList()
        // Sanity: the fixture should include several overloads otherwise the
        // test is not actually exercising the disambiguation pass.
        Assert.True(candidates.Count >= 4, "expected a multi-overload fixture")
        // Pass them in via the synthesized `Equal` name on a real CLR Equal
        // probe class so this exercises the same EvaluateCandidate path.
        let nameMatches = candidates.Where((m MethodInfo) -> m.Name == "Equal").ToList()
        let result = ClrOverloadResolution.Resolve(nameMatches, []Type{typeof(string), typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.False(result.Best!!.IsGenericMethod)
        let parameters = result.Best!!.GetParameters()
        Assert.Equal(2, parameters.Length)
        Assert.Equal(typeof(string), parameters[0].ParameterType)
        Assert.Equal(typeof(string), parameters[1].ParameterType)
    }

    @Fact
    func Resolve_ExplicitTypeArgumentStillBindsGeneric_FromStringStringArgs() {
        // Issue #505: `Equal[string]("a", "a")` continues to work — the
        // explicit type-argument path picks the generic Equal<T>(T, T) and
        // closes it with T=string. Verifies the explicit-arg path isn't
        // broken by the new non-generic-preference tie-breaker.
        let generic MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Equal_TT", BindingFlags.Public | BindingFlags.Static)
        let nonGeneric MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Equal_StringString", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{generic!!, nonGeneric!!},
            []Type{typeof(string), typeof(string)},
            explicitTypeArgs: []Type{typeof(string)}
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.True(result.Best!!.IsGenericMethod)
        Assert.Equal(typeof(string), result.Best!!.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_InferableGenericEqual_FromTwoIntArgs_PicksGeneric_NoAmbiguity() {
        // Issue #505: with int arguments and the same family of Equal overloads,
        // only the generic Equal<T>(T, T) (closed with T=int) applies via
        // identity conversion. The string-typed overloads are not applicable
        // and the numeric-widening to other overloads would lose on conversion
        // ranking, so the resolver returns a unique best without ambiguity.
        let candidates = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "Equal")
            .ToList()
        let result = ClrOverloadResolution.Resolve(candidates, []Type{typeof(int32), typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.True(result.Best!!.IsGenericMethod)
        Assert.Equal(typeof(int32), result.Best!!.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_InferableGenericNotEqual_FromTwoStringArgs_PicksNonGeneric() {
        // Issue #505 companion: same reasoning for NotEqual. Non-generic
        // NotEqual(string, string) wins over generic NotEqual<T>(T, T).
        let candidates = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "NotEqual")
            .ToList()
        let result = ClrOverloadResolution.Resolve(candidates, []Type{typeof(string), typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.False(result.Best!!.IsGenericMethod)
        let parameters = result.Best!!.GetParameters()
        Assert.Equal(typeof(string), parameters[0].ParameterType)
        Assert.Equal(typeof(string), parameters[1].ParameterType)
    }

    @Fact
    func Resolve_TrulyAmbiguousOverloads_AreReported_WithCandidateList() {
        // Issue #505: when the surviving pool still ties after every C# tie-
        // breaker (e.g. two non-generic overloads taking unrelated reference
        // types, both reachable from the argument by reference conversion),
        // the resolver returns Ambiguous with the competing candidates so the
        // caller can format them into the GS0160 diagnostic.
        let first MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Take_IA", BindingFlags.Public | BindingFlags.Static)
        let second MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Take_IB", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve(
            []MethodInfo{first!!, second!!},
            []Type{
                NativeMetadataFixtures.GetType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+BothAB"
                )
            }
        )
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome)
        Assert.Equal(2, result.Ambiguous.Length)
        let signatures = result.Ambiguous.Select(ClrOverloadResolution.FormatMethodSignature).ToArray()
        Assert.Contains(signatures, (s string) -> s.Contains("IA"))
        Assert.Contains(signatures, (s string) -> s.Contains("IB"))
    }

    @Fact
    func FormatMethodSignature_FormatsGenericMethod_WithBracketedTypeArgs() {
        // Issue #505: the diagnostic helper must surface a readable signature
        // including the closed generic type arguments.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Identity", BindingFlags.Public | BindingFlags.Static)
        let closed = open_!!.MakeGenericMethod(typeof(string))
        let formatted = ClrOverloadResolution.FormatMethodSignature(closed)
        Assert.Equal("G_Identity[String](String)", formatted)
    }

    @Fact
    func FormatMethodSignature_FormatsNonGenericMethod_PlainParens() {
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("F_Int", BindingFlags.Public | BindingFlags.Static)
        let formatted = ClrOverloadResolution.FormatMethodSignature(method!!)
        Assert.Equal("F_Int(Int32)", formatted)
    }

    @Fact
    func FormatMethodSignature_FormatsGenericTypeArguments_InParameters() {
        // Generic parameter types like IEnumerable<T> should be rendered with
        // bracketed arguments rather than mangled (`IEnumerable`1`) names.
        let method MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
        )
            .GetMethod("G_Enumerable", BindingFlags.Public | BindingFlags.Static)
        let closed = method!!.MakeGenericMethod(typeof(int32))
        let formatted = ClrOverloadResolution.FormatMethodSignature(closed)
        Assert.Equal("G_Enumerable[Int32](IEnumerable[Int32])", formatted)
    }

    // ----- Issue #750 / ADR-0088: constraint-aware overload resolution -----
    @Fact
    func Resolve_DropsCandidate_WhenClassConstraintViolatedByValueType() {
        // ConstraintFixture.OnlyClass<T>(T x) where T : class — calling with an
        // int argument must NOT bind. The MetadataLoadContext-style path won't
        // throw from MakeGenericMethod, so the explicit constraint check has
        // to drop the candidate.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture"
        )
            .GetMethod("OnlyClass", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_DropsCandidate_WhenStructConstraintViolatedByReferenceType() {
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture"
        )
            .GetMethod("OnlyStruct", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_DropsCandidate_WhenStructConstraintViolatedByNullableValueType() {
        // `where T : struct` rejects Nullable<T> — int? is not a "non-nullable
        // value type" per ECMA-335.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture"
        )
            .GetMethod("OnlyStruct", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(int32?)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_DropsCandidate_WhenNewConstraintViolated() {
        // ConstraintFixture.OnlyNew<T>() where T : new() — string has no
        // public parameterless ctor.
        let open_ MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ConstraintFixture"
        )
            .GetMethod("OnlyNew", BindingFlags.Public | BindingFlags.Static)
        let result = ClrOverloadResolution.Resolve([]MethodInfo{open_!!}, []Type{typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.NoneApplicable, result.Outcome)
    }

    @Fact
    func Resolve_DisjointClassStructOverloads_PicksClassForReferenceType() {
        // The repro from issue #750: two extensions with identical parameter
        // shape (modulo the receiver), disjoint class/struct constraints. The
        // binder must pick the class overload when called with a string.
        let both = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+MapLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "Map")
        let result = ClrOverloadResolution.Resolve(both, []Type{typeof(string), typeof((string) -> string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        // Class overload's T resolves to string; struct overload couldn't infer
        // T at all from a string receiver.
        Assert.Equal(typeof(string), result.Best!!.GetGenericArguments()[0])
        Assert.Equal(
            NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+MapLike"),
            result.Best!!.DeclaringType
        )
    }

    @Fact
    func Resolve_DisjointClassStructOverloads_PicksStructForNullableValueType() {
        let both = NativeMetadataFixtures
            .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+MapLike")
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where((m MethodInfo) -> m.Name == "Map")
        let result = ClrOverloadResolution.Resolve(both, []Type{typeof(int32?), typeof((int32) -> int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        // Struct overload binds T = int.
        Assert.Equal(typeof(int32), result.Best!!.GetGenericArguments()[0])
    }

    @Fact
    func Resolve_ThreeWayConstraints_PrefersStructOverNone_ForValueArgument() {
        // class, struct, and no-constraint overloads of the same shape. For a
        // non-nullable value type the struct overload wins; the unconstrained
        // overload is dominated by constraint-specificity per ADR-0088.
        let all IEnumerable[MethodInfo]? = ThreeWayCandidates()
        let result = ClrOverloadResolution.Resolve(all!!, []Type{typeof(int32)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal(
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayStruct"
            ),
            result.Best!!.DeclaringType
        )
    }

    @Fact
    func Resolve_ThreeWayConstraints_PrefersClassOverNone_ForReferenceArgument() {
        let all IEnumerable[MethodInfo]? = ThreeWayCandidates()
        let result = ClrOverloadResolution.Resolve(all!!, []Type{typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal(
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayClass"
            ),
            result.Best!!.DeclaringType
        )
    }

    @Fact
    func Resolve_FallsThroughToUnconstrained_WhenConstrainedCandidatesFail() {
        // Receiver is Nullable<int> — neither class (because Nullable<T> is a
        // value type) nor struct (because the struct constraint excludes
        // Nullable<T>) applies. The unconstrained overload survives and wins.
        let all IEnumerable[MethodInfo]? = ThreeWayCandidates()
        let result = ClrOverloadResolution.Resolve(all!!, []Type{typeof(int32?)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
        Assert.Equal(
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayNone"
            ),
            result.Best!!.DeclaringType
        )
    }

    @Fact
    func Resolve_SameSpecificityOverloads_ReportsAmbiguity() {
        // Two overloads with identical constraints from disjoint declaring
        // classes cannot be disambiguated by the new constraint-specificity
        // tie-break; the existing ambiguity diagnostic fires.
        let all = []MethodInfo{
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeA"
            )
                .GetMethod("Take", BindingFlags.Public | BindingFlags.Static)!!,
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+AmbiguousSameShapeB"
            )
                .GetMethod("Take", BindingFlags.Public | BindingFlags.Static)!!
        }
        let result = ClrOverloadResolution.Resolve(all, []Type{typeof(string)})
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Ambiguous, result.Outcome)
    }

    // ----- Issue #1634: supplementaryInterfaceCheck / constantNarrowingArgumentCheck
    // must be per-call parameters, not shared mutable state, so that concurrent
    // and nested (reentrant) `Resolve<T>` calls never observe each other's hook. -----
    @Fact
    async func Resolve_SupplementaryInterfaceCheck_IsIsolatedAcrossConcurrentCalls() {
        // Two disjoint interface targets, both applicable only through a
        // per-call supplementaryInterfaceCheck (the `object`-typed argument
        // stands in for a user-class surrogate CLR type, mirroring issue
        // #658). Hammer Resolve<T> from many threads at once, each thread
        // consistently requesting ONE of the two targets: if the hooks were
        // still shared static state, some iterations would race and resolve
        // to the wrong candidate (or throw NullReferenceException from a
        // hook nulled out mid-flight by another thread).
        let takeIA MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Take_IA", BindingFlags.Public | BindingFlags.Static)
        let takeIB MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Take_IB", BindingFlags.Public | BindingFlags.Static)
        let candidates = []MethodInfo{takeIA!!, takeIB!!}
        let RunFor = func (wantInterface Type, expectedName string, iterations int32, errors List[Exception]) {
            for var i = 0; i < iterations; i++ {
                try {
                    let result = ClrOverloadResolution.Resolve(
                        candidates,
                        []Type{typeof(object)},
                        supplementaryInterfaceCheck: (source Type, target Type) -> target == wantInterface
                    )
                    if result.Outcome != ClrOverloadResolution
                        .ResolutionOutcome
                        .Resolved ||
                        result.Best!!.Name != expectedName {
                        lock errors {
                            errors.Add(
                                Exception(
                                    "Expected $expectedName for $wantInterface, got ${result.Outcome}/${result.Best?.Name}"
                                )
                            )
                        }
                    }
                } catch (ex Exception) {
                    lock errors {
                        errors.Add(ex)
                    }
                }
            }
        }
        let errors = List[Exception]()
        const iterations = 500
        let taskA = Task.Run(
            () -> RunFor(
                NativeMetadataFixtures.GetType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IA"
                ),
                "Take_IA",
                iterations,
                errors
            )
        )
        let taskB = Task.Run(
            () -> RunFor(
                NativeMetadataFixtures.GetType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IB"
                ),
                "Take_IB",
                iterations,
                errors
            )
        )
        await Task.WhenAll(taskA, taskB)
        Assert.Empty(errors)
    }

    @Fact
    func Resolve_SupplementaryInterfaceCheck_SurvivesNestedResolveInsideHookCallback() {
        // Reentrancy guard: a supplementaryInterfaceCheck callback that itself
        // triggers a nested Resolve<T> call (mirroring RebindInlineOutVarArguments
        // / lambda re-binding running "inside the hook window" per issue #1634)
        // must not corrupt the outer call's own hook. With hooks threaded as
        // parameters instead of mutable statics, the outer closure is captured
        // by value and is unaffected by whatever the nested call does.
        let takeIA MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Take_IA", BindingFlags.Public | BindingFlags.Static)
        let takeIB MethodInfo? = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike"
        )
            .GetMethod("Take_IB", BindingFlags.Public | BindingFlags.Static)
        let candidates = []MethodInfo{takeIA!!, takeIB!!}
        var nestedCallCount = 0
        let outerResult = ClrOverloadResolution.Resolve(
            candidates,
            []Type{typeof(object)},
            supplementaryInterfaceCheck: (source Type, target Type) -> {
                if target == NativeMetadataFixtures.GetType(
                    "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IA"
                ) {
                    // Nested resolution, run from *inside* the outer hook,
                    // using a DIFFERENT hook that targets IB. Under the old
                    // "install -> Resolve -> finally null" static-field
                    // pattern this would null the outer's field once the
                    // nested call's finally ran, and any subsequent
                    // ClassifyImplicit probe of the outer call would silently
                    // stop recognising IA.
                    nestedCallCount++
                    let nested = ClrOverloadResolution.Resolve(
                        candidates,
                        []Type{typeof(object)},
                        supplementaryInterfaceCheck: (
                            nestedSource Type,
                            nestedTarget Type
                        ) -> nestedTarget == NativeMetadataFixtures.GetType(
                            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+EqualLike+IB"
                        )
                    )
                    Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, nested.Outcome)
                    Assert.Equal("Take_IB", nested.Best!!.Name)
                    return true
                }
                return false
            }
        )
        Assert.True(nestedCallCount > 0)
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, outerResult.Outcome)
        Assert.Equal("Take_IA", outerResult.Best!!.Name)
    }

    shared {
        private func Resolve(a string, b string, argTypes[]Type) MethodInfo? {
            let first MethodInfo? = NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
            )
                .GetMethod(a, BindingFlags.Public | BindingFlags.Static)
            let second MethodInfo? = NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+Fixture"
            )
                .GetMethod(b, BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(first)
            Assert.NotNull(second)
            let result = ClrOverloadResolution.Resolve([]MethodInfo{first!!, second!!}, argTypes)
            Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome)
            return result.Best
        }

        private func ThreeWayCandidates() sequence[MethodInfo?] {
            yield NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayClass"
            )
                .GetMethod("Choose", BindingFlags.Public | BindingFlags.Static)
            yield NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayStruct"
            )
                .GetMethod("Choose", BindingFlags.Public | BindingFlags.Static)
            yield NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionTests+ThreeWayNone"
            )
                .GetMethod("Choose", BindingFlags.Public | BindingFlags.Static)
        }
    }
}
