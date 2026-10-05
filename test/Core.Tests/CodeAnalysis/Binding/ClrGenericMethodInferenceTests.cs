// <copyright file="ClrGenericMethodInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Stream F follow-up — verifies that calls to open generic CLR methods bind
/// after their type arguments are inferred from supplied argument types.
/// </summary>
public class ClrGenericMethodInferenceTests
{
    [Fact]
    public void Enumerable_Repeat_InfersTResultFromArgument()
    {
        // Enumerable.Repeat<TResult>(TResult element, int count); from
        // (int, int) inference picks TResult = int and the call binds without
        // explicit type arguments.
        var source = @"
import System.Linq

let seq = Enumerable.Repeat(7, 3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Empty_FailsWithoutInferableArgument()
    {
        // Enumerable.Empty<TResult>() has no arg-driven inference path; the
        // candidate cannot bind without explicit type arguments. The exact
        // diagnostic is "unable to find function" (matches the pre-Stream F
        // behaviour for generic methods with no inferable args).
        var source = @"
import System.Linq

let seq = Enumerable.Empty()
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Repeat_ConflictingArgTypes_DiagnoseAsNotFound()
    {
        // Repeat takes (TResult, int). Passing (int, string) does not match
        // the int second-parameter, so inference succeeds (T=int from arg0)
        // but applicability fails (string is not implicitly int). The call
        // does not bind.
        var source = @"
import System.Linq

let seq = Enumerable.Repeat(7, ""three"")
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Count_InfersTFromSlice()
    {
        // #611: Enumerable.Count<T>(IEnumerable<T>) must infer T from a
        // []string argument. The CLR-level UnifyForInference walks the
        // array's interfaces to find IEnumerable<string>.
        var source = @"
import System.Linq

var s = []string{""a"", ""b""}
let n = Enumerable.Count(s)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Enumerable_Contains_InfersTFromSlice()
    {
        // #611: Enumerable.Contains<T>(IEnumerable<T>, T) infers T from a
        // []int32 slice argument.
        var source = @"
import System.Linq

var s = []int32{1, 2, 3}
let found = Enumerable.Contains(s, 2)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Theory]
    [InlineData(typeof(ObjectFirstComparer<>))]
    [InlineData(typeof(StringFirstComparer<>))]
    public void ConstructedDefinitionFallback_DoesNotInferFromMultipleComparerProjections(Type definition)
    {
        var marker = NewMarkerType();
        var argument = definition.MakeGenericType(marker);
        Assert.Equal("TypeBuilderInstantiation", argument.GetType().Name);
        Assert.Throws<NotSupportedException>(() => argument.GetInterfaces());
        Assert.Equal(2, definition.GetInterfaces().Length);

        var infer = typeof(InferenceFixture).GetMethod(nameof(InferenceFixture.Infer));
        Assert.NotNull(infer);
        Assert.False(ClrOverloadResolution.TryInferTypeArguments(infer, [argument], out _));

        var select = typeof(InferenceFixture).GetMethod(nameof(InferenceFixture.Select));
        Assert.NotNull(select);
        Assert.True(ClrOverloadResolution.TryInferTypeArguments(select, [argument, typeof(string)], out var inferred));
        Assert.Equal(new[] { typeof(string) }, inferred);
    }

    [Fact]
    public void ConstructedDefinitionFallback_SubstitutesTheUniqueComparerProjection()
    {
        var marker = NewMarkerType();
        var argument = typeof(SingleComparer<>).MakeGenericType(marker);
        Assert.Equal("TypeBuilderInstantiation", argument.GetType().Name);
        Assert.Throws<NotSupportedException>(() => argument.GetInterfaces());

        var infer = typeof(InferenceFixture).GetMethod(nameof(InferenceFixture.Infer));
        Assert.NotNull(infer);
        Assert.True(ClrOverloadResolution.TryInferTypeArguments(infer, [argument], out var inferred));
        Assert.Equal(new Type[] { marker }, inferred);
    }

    private static TypeBuilder NewMarkerType()
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("Issue4780ConstructedDefinition"),
            AssemblyBuilderAccess.Run);
        return assembly.DefineDynamicModule("Main").DefineType("Marker", TypeAttributes.Public);
    }

    private sealed class ObjectFirstComparer<TMarker> : IComparer<object>, IComparer<string>
    {
        public int Compare(object? x, object? y) => 0;

        public int Compare(string? x, string? y) => 0;
    }

    private sealed class StringFirstComparer<TMarker> : IComparer<string>, IComparer<object>
    {
        public int Compare(string? x, string? y) => 0;

        public int Compare(object? x, object? y) => 0;
    }

    private sealed class SingleComparer<T> : IComparer<T>
    {
        public int Compare(T? x, T? y) => 0;
    }

    private static class InferenceFixture
    {
        public static Type Infer<T>(IComparer<T> comparer) => typeof(T);

        public static Type Select<T>(IComparer<T> comparer, T value) => typeof(T);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
