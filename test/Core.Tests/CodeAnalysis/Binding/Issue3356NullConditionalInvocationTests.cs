// <copyright file="Issue3356NullConditionalInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #3356 binding and emitted-runtime coverage.</summary>
public class Issue3356NullConditionalInvocationTests
{
    [Fact]
    public void ComplexReceivers_EvaluateOnce_AndArgumentsOnlyWhenPresent()
    {
        var result = EmittedOracle.Evaluate("""
            var receiverCalls = 0
            var argumentCalls = 0
            var invokeCalls = 0
            var present = false

            func Argument() int32 {
                argumentCalls++
                return 5
            }

            func GetHandler() ((int32) -> int32)? {
                receiverCalls++
                if present {
                    return (value int32) -> {
                        invokeCalls++
                        return value * 2
                    }
                }
                return nil
            }

            func run() int32 {
                let missing = GetHandler()?(Argument()) ?? -1
                present = true
                let called = GetHandler()?(Argument()) ?? -1
                return missing * 10000 + called * 1000 + receiverCalls * 100 + argumentCalls * 10 + invokeCalls
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(211, result.Value);
    }

    [Fact]
    public void CallIndexerParenthesizedCoalesceAndMemberChains_BindAndRun()
    {
        var result = EmittedOracle.Evaluate("""
            class Box {
                var Handler ((int32) -> int32)?
            }

            var indexCalls = 0
            func Index() int32 {
                indexCalls++
                return 0
            }

            func GetBox() Box -> Box{Handler: (value int32) -> value + 1}

            func run() int32 {
                let handlers = []((int32) -> int32)?{(value int32) -> value + 2}
                let fallback ((int32) -> int32)? = (value int32) -> value + 3
                let missing ((int32) -> int32)? = nil
                let a = handlers[Index()]?(1) ?? 0
                let b = (fallback)?(1) ?? 0
                let c = (missing ?? fallback)?(1) ?? 0
                let d = GetBox().Handler?(1) ?? 0
                return a * 10000 + b * 1000 + c * 100 + d * 10 + indexCalls
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(34421, result.Value);
    }

    [Fact]
    public void GenericFunctionType_InvokeAndNullConditionalInvoke_Resolve()
    {
        var result = EmittedOracle.Evaluate("""
            func InvokeDirect[T any, R any](callback (T) -> R, value T) R {
                return callback.Invoke(value)
            }

            func InvokeMaybe[T any, R any](callback ((T) -> R)?, value T) R? {
                return callback?.Invoke(value)
            }

            func run() int32 {
                let callback (int32) -> int32 = (value int32) -> value * 2
                let stringify (int32) -> string = (value int32) -> value.ToString()
                let direct = InvokeDirect[int32, int32](callback, 5)
                let present = InvokeMaybe[int32, string](stringify, 6) ?? "missing"
                let missing = InvokeMaybe[int32, string](nil, 7) ?? "missing"
                return direct * 100
                    + (if present == "6" { 10 } else { 0 })
                    + (if missing == "missing" { 1 } else { 0 })
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(1011, result.Value);
    }

    [Fact]
    public void GenericInvoke_PreservesConstraintsNestedNullabilityAndAsyncReturn()
    {
        var result = EmittedOracle.Evaluate("""
            package P
            import System
            import System.Threading.Tasks

            class GenericInvoker[T] {
                func Apply[R any](callback (T) -> R, value T) R {
                    return callback.Invoke(value)
                }
            }

            func InvokeConstrained[T IComparable[T]](callback (T) -> T, value T) T {
                return callback.Invoke(value)
            }

            func InvokeNested[T any](callback (T?) -> T?, value T?) T? {
                return callback.Invoke(value)
            }

            async func InvokeAsync[T any](callback (T) -> Task[T], value T) T {
                return await callback.Invoke(value)
            }

            func run() int32 {
                let constrained = InvokeConstrained[int32]((value int32) -> value + 1, 4)
                let nested = InvokeNested[string]((value string?) -> value, "x")
                let asyncValue = InvokeAsync[int32]((value int32) -> Task.FromResult[int32](value + 2), 5)
                    .GetAwaiter()
                    .GetResult()
                let mixed = GenericInvoker[int32]().Apply[string]((value int32) -> value.ToString(), 8)
                return constrained * 100
                    + (if nested == "x" { 10 } else { 0 })
                    + asyncValue
                    + (if mixed == "8" { 1 } else { 0 })
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(518, result.Value);
    }

    [Fact]
    public void NullConditionalCallResult_GenericNamedDelegates_PreserveRefKinds()
    {
        var result = EmittedOracle.Evaluate("""
            type RefAction[T] = delegate func(ref value T)
            type OutAction[T] = delegate func(out value T)
            type InPredicate[T] = delegate func(in value T) bool

            func RefOrNil[T any](action RefAction[T]?) RefAction[T]? -> action
            func OutOrNil[T any](action OutAction[T]?) OutAction[T]? -> action
            func InOrNil[T any](action InPredicate[T]?) InPredicate[T]? -> action

            func run() int32 {
                let refAction RefAction[int32] = (ref value int32) -> { value = value + 2 }
                let outAction OutAction[int32] = (out value int32) -> { value = 42 }
                let inPredicate InPredicate[int32] = (in value int32) -> value == 42
                var value = 40
                RefOrNil[int32](refAction)?(ref value)
                OutOrNil[int32](outAction)?(out value)
                let accepted = InOrNil[int32](inPredicate)?(in value) ?? false
                RefOrNil[int32](nil)?(ref value)
                return value + (if accepted { 1 } else { 0 })
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(43, result.Value);
    }

    [Fact]
    public void NonCallablePostfixReceiver_ReportsNotFunctionWithoutTernaryCascade()
    {
        var result = EmittedOracle.Evaluate("""
            func GetValue() int32 -> 1
            GetValue()?(2)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0131");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS0155");
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("ColonToken", System.StringComparison.Ordinal));
    }

    [Fact]
    public void NullableGenericFunctionInvoke_DiagnosticNamesReceiverAndDirectRemedy()
    {
        var result = EmittedOracle.Evaluate("""
            func Bad[T any, R any](callback ((T) -> R)?, value T) {
                callback.Invoke(value)
            }
            """);

        var diagnostic = Assert.Single(result.Diagnostics, diagnostic => diagnostic.Id == "GS0503");
        Assert.Contains("'callback'", diagnostic.Message, System.StringComparison.Ordinal);
        Assert.Contains("'?(...)'", diagnostic.Message, System.StringComparison.Ordinal);
        Assert.DoesNotContain("'?.Invoke(...)'", diagnostic.Message, System.StringComparison.Ordinal);
    }
}
