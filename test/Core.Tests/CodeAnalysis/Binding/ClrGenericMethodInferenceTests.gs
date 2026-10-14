// <copyright file="ClrGenericMethodInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Reflection
import System.Reflection.Emit
import Xunit

/// Stream F follow-up — verifies that calls to open generic CLR methods bind
/// after their type arguments are inferred from supplied argument types.
open class ClrGenericMethodInferenceTests {
    @Fact
    func Enumerable_Repeat_InfersTResultFromArgument() {
        // Enumerable.Repeat<TResult>(TResult element, int count); from
        // (int, int) inference picks TResult = int and the call binds without
        // explicit type arguments.
        let source = `
import System.Linq

let seq = Enumerable.Repeat(7, 3)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Enumerable_Empty_FailsWithoutInferableArgument() {
        // Enumerable.Empty<TResult>() has no arg-driven inference path; the
        // candidate cannot bind without explicit type arguments. The exact
        // diagnostic is "unable to find function" (matches the pre-Stream F
        // behaviour for generic methods with no inferable args).
        let source = `
import System.Linq

let seq = Enumerable.Empty()
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Enumerable_Repeat_ConflictingArgTypes_DiagnoseAsNotFound() {
        // Repeat takes (TResult, int). Passing (int, string) does not match
        // the int second-parameter, so inference succeeds (T=int from arg0)
        // but applicability fails (string is not implicitly int). The call
        // does not bind.
        let source = `
import System.Linq

let seq = Enumerable.Repeat(7, "three")
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Enumerable_Count_InfersTFromSlice() {
        // #611: Enumerable.Count<T>(IEnumerable<T>) must infer T from a
        // []string argument. The CLR-level UnifyForInference walks the
        // array's interfaces to find IEnumerable<string>.
        let source = `
import System.Linq

var s = []string{"a", "b"}
let n = Enumerable.Count(s)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Enumerable_Contains_InfersTFromSlice() {
        // #611: Enumerable.Contains<T>(IEnumerable<T>, T) infers T from a
        // []int32 slice argument.
        let source = `
import System.Linq

var s = []int32{1, 2, 3}
let found = Enumerable.Contains(s, 2)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Theory
    @InlineData(typeof(ObjectFirstComparer[_]))
    @InlineData(typeof(StringFirstComparer[_]))
    func ConstructedDefinitionFallback_DoesNotInferFromMultipleComparerProjections(definition Type) {
        let marker = NewMarkerType()
        let argument = definition.MakeGenericType(marker)
        Assert.Equal("TypeBuilderInstantiation", argument.GetType().Name)
        Assert.Throws[NotSupportedException](
            func () object? {
                return argument.GetInterfaces()
            }
        )
        Assert.Equal(2, definition.GetInterfaces().Length)
        let infer = typeof(InferenceFixture).GetMethod("Infer")
        Assert.NotNull(infer)
        Assert.False(ClrOverloadResolution.TryInferTypeArguments(infer!!, []Type? {argument}, out _))
        let select_ = typeof(InferenceFixture).GetMethod("Select")
        Assert.NotNull(select_)
        Assert.True(
            ClrOverloadResolution.TryInferTypeArguments(select_!!, []Type? {argument, typeof(string)}, out var inferred)
        )
        Assert.Equal([]Type{typeof(string)}, inferred)
    }

    @Fact
    func ConstructedDefinitionFallback_SubstitutesTheUniqueComparerProjection() {
        let marker = NewMarkerType()
        let argument = typeof(SingleComparer[_]).MakeGenericType(marker)
        Assert.Equal("TypeBuilderInstantiation", argument.GetType().Name)
        Assert.Throws[NotSupportedException](
            func () object? {
                return argument.GetInterfaces()
            }
        )
        let infer = typeof(InferenceFixture).GetMethod("Infer")
        Assert.NotNull(infer)
        Assert.True(ClrOverloadResolution.TryInferTypeArguments(infer!!, []Type? {argument}, out var inferred))
        Assert.Equal([]Type{marker}, inferred)
    }

    private class ObjectFirstComparer[TMarker] : IComparer[object], IComparer[string] {
        func Compare(x object?, y object?) int32 -> 0

        func Compare(x string?, y string?) int32 -> 0
    }

    private class StringFirstComparer[TMarker] : IComparer[string], IComparer[object] {
        func Compare(x string?, y string?) int32 -> 0

        func Compare(x object?, y object?) int32 -> 0
    }

    private class SingleComparer[T] : IComparer[T] {
        func Compare(x T?, y T?) int32 -> 0
    }

    private shared class InferenceFixture {
        func Infer[T](comparer IComparer[T]) Type -> typeof(T)

        func Select[T](comparer IComparer[T], value T) Type -> typeof(T)
    }

    shared {
        private func NewMarkerType() TypeBuilder {
            let assembly = AssemblyBuilder.DefineDynamicAssembly(
                AssemblyName("Issue4780ConstructedDefinition"),
                AssemblyBuilderAccess.Run
            )
            return assembly.DefineDynamicModule("Main").DefineType("Marker", TypeAttributes.Public)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
