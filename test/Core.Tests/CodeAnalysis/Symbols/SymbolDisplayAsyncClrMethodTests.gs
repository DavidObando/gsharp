// <copyright file="SymbolDisplayAsyncClrMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols.Display
import System.Reflection
import System.Threading.Tasks
import Xunit

/// ADR-0023 parity for imported CLR methods: a reflected `async` method
/// exposes a `Task[R]` / `ValueTask[R]` return in metadata, but
/// (cref:SymbolDisplay) renders it as `async func ... R` to match
/// how G#-authored `async func` declarations display.
open class SymbolDisplayAsyncClrMethodTests {
    @Fact
    func AsyncTaskOfT_RendersAsAsyncFuncWithUnwrappedResult() {
        let method MethodInfo? = typeof(AsyncClrMethodSamples).GetMethod("AsyncResult")
        let rendered = SymbolDisplay.ToDisplayString(method!!, SymbolDisplayFormat.Signature)
        Assert.Equal("async func AsyncResult(name string) int32", rendered)
    }

    @Fact
    func AsyncNonGenericTask_RendersAsAsyncFuncWithNoReturnType() {
        let method MethodInfo? = typeof(AsyncClrMethodSamples).GetMethod("AsyncNoResult")
        let rendered = SymbolDisplay.ToDisplayString(method!!, SymbolDisplayFormat.Signature)
        Assert.Equal("async func AsyncNoResult()", rendered)
    }

    @Fact
    func AsyncValueTaskOfT_RendersAsAsyncFuncWithUnwrappedResult() {
        let method MethodInfo? = typeof(AsyncClrMethodSamples).GetMethod("AsyncValueResult")
        let rendered = SymbolDisplay.ToDisplayString(method!!, SymbolDisplayFormat.Signature)
        Assert.Equal("async func AsyncValueResult() int32", rendered)
    }

    @Fact
    func NonAsyncTaskOfT_KeepsTaskReturnAndNoAsyncModifier() {
        // A method that returns Task<int> WITHOUT being compiled from async/await
        // is genuinely Task-returning to the caller, so the display must not hide
        // it nor add the `async` modifier.
        let method MethodInfo? = typeof(AsyncClrMethodSamples).GetMethod("PlainTask")
        let rendered = SymbolDisplay.ToDisplayString(method!!, SymbolDisplayFormat.Signature)
        Assert.Equal("func PlainTask() Task[int32]", rendered)
    }

    @Fact
    func AsyncMethod_HoverFormat_IncludesReceiverAndUnwrappedResult() {
        let method MethodInfo? = typeof(AsyncClrMethodSamples).GetMethod("AsyncResult")
        let rendered = SymbolDisplay.ToDisplayString(method!!, SymbolDisplayFormat.Hover)
        Assert.StartsWith("async func (", rendered)
        Assert.EndsWith(") AsyncResult(name string) int32", rendered)
    }
}

internal shared class AsyncClrMethodSamples {
    async func AsyncResult(name string) int32 -> name.Length

    async func AsyncNoResult() { }

    async func AsyncValueResult() ValueTask[int32] -> 1

    func PlainTask() Task[int32] -> Task.FromResult(1)
}
