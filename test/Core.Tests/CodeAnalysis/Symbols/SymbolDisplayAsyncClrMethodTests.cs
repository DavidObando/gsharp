// <copyright file="SymbolDisplayAsyncClrMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0023 parity for imported CLR methods: a reflected <c>async</c> method
/// exposes a <c>Task[R]</c> / <c>ValueTask[R]</c> return in metadata, but
/// <see cref="SymbolDisplay"/> renders it as <c>async func ... R</c> to match
/// how G#-authored <c>async func</c> declarations display.
/// </summary>
public class SymbolDisplayAsyncClrMethodTests
{
    [Fact]
    public void AsyncTaskOfT_RendersAsAsyncFuncWithUnwrappedResult()
    {
        var method = typeof(AsyncClrMethodSamples).GetMethod(nameof(AsyncClrMethodSamples.AsyncResult));

        var rendered = SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Signature);

        Assert.Equal("async func AsyncResult(name string) int32", rendered);
    }

    [Fact]
    public void AsyncNonGenericTask_RendersAsAsyncFuncWithNoReturnType()
    {
        var method = typeof(AsyncClrMethodSamples).GetMethod(nameof(AsyncClrMethodSamples.AsyncNoResult));

        var rendered = SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Signature);

        Assert.Equal("async func AsyncNoResult()", rendered);
    }

    [Fact]
    public void AsyncValueTaskOfT_RendersAsAsyncFuncWithUnwrappedResult()
    {
        var method = typeof(AsyncClrMethodSamples).GetMethod(nameof(AsyncClrMethodSamples.AsyncValueResult));

        var rendered = SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Signature);

        Assert.Equal("async func AsyncValueResult() int32", rendered);
    }

    [Fact]
    public void NonAsyncTaskOfT_KeepsTaskReturnAndNoAsyncModifier()
    {
        // A method that returns Task<int> WITHOUT being compiled from async/await
        // is genuinely Task-returning to the caller, so the display must not hide
        // it nor add the `async` modifier.
        var method = typeof(AsyncClrMethodSamples).GetMethod(nameof(AsyncClrMethodSamples.PlainTask));

        var rendered = SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Signature);

        Assert.Equal("func PlainTask() Task[int32]", rendered);
    }

    [Fact]
    public void AsyncMethod_HoverFormat_IncludesReceiverAndUnwrappedResult()
    {
        var method = typeof(AsyncClrMethodSamples).GetMethod(nameof(AsyncClrMethodSamples.AsyncResult));

        var rendered = SymbolDisplay.ToDisplayString(method, SymbolDisplayFormat.Hover);

        Assert.StartsWith("async func (", rendered);
        Assert.EndsWith(") AsyncResult(name string) int32", rendered);
    }
}

#pragma warning disable CS1998 // async method without await: intentional — the test only inspects metadata, not runtime behavior.
file static class AsyncClrMethodSamples
{
    public static async Task<int> AsyncResult(string name) => name.Length;

    public static async Task AsyncNoResult()
    {
    }

    public static async ValueTask<int> AsyncValueResult() => 1;

    public static Task<int> PlainTask() => Task.FromResult(1);
}
#pragma warning restore CS1998
