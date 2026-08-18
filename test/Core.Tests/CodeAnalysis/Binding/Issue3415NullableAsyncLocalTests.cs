// <copyright file="Issue3415NullableAsyncLocalTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue3415NullableAsyncLocalTests
{
    [Fact]
    public void NullableReferenceTypeArgument_ProjectsThroughClrPropertySetter()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading

            let state = AsyncLocal[string?]()
            state.Value = nil
            state.Value == nil
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullableState_NestedExecutionContextsAndConcurrentTasks_RestoreIndependently()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Threading
            import System.Threading.Tasks

            func Run() int32 {
                let state = AsyncLocal[string?]()
                state.Value = nil
                let nullContext = ExecutionContext.Capture()
                if nullContext == nil {
                    return -1
                }

                state.Value = "outer"
                let outerContext = ExecutionContext.Capture()
                if outerContext == nil {
                    return -2
                }

                state.Value = "root"
                var score = 0
                ExecutionContext.Run(outerContext, (ignored object?) -> {
                    if state.Value == "outer" {
                        score++
                    }

                    state.Value = "inner-parent"
                    ExecutionContext.Run(nullContext, (nestedIgnored object?) -> {
                        if state.Value == nil {
                            score++
                        }

                        state.Value = "inner-child"
                    }, nil)

                    if state.Value == "inner-parent" {
                        score++
                    }
                }, nil)

                if state.Value == "root" {
                    score++
                }

                let barrier = Barrier(2)
                state.Value = "left"
                let left = Task.Run(() -> {
                    let inherited = state.Value == "left"
                    state.Value = nil
                    barrier.SignalAndWait()
                    return inherited && state.Value == nil
                })

                state.Value = "right"
                let right = Task.Run(() -> {
                    let inherited = state.Value == "right"
                    state.Value = "right-child"
                    barrier.SignalAndWait()
                    return inherited && state.Value == "right-child"
                })

                if left.Result {
                    score++
                }

                if right.Result {
                    score++
                }

                if state.Value == "right" {
                    score++
                }

                return score
            }

            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }
}
