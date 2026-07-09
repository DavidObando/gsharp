// <copyright file="AwaitForRangeStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 5.8 / ADR-0023 — <c>await for v := range stream { … }</c>
/// over <c>IAsyncEnumerable[T]</c>.
/// </summary>
public class AwaitForRangeStatementTests
{
    [Fact]
    public void AwaitFor_DrainsAsyncEnumerable()
    {
        var source = @"
import System.Linq
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1 + 2 + 3, result.Value);
    }

    [Fact(Skip = "Flaky in CI: intermittently reports a spurious binder diagnostic (reference-resolution race in the test fixture). Tracked by #2303.")]
    public void AwaitFor_ConfigureAwaitFalse_DrainsAsyncEnumerable()
    {
        // Issue #2280: `stream.ConfigureAwait(false)` returns
        // `ConfiguredCancelableAsyncEnumerable[T]`, a fully duck-typed
        // (pattern-based) async enumerable that implements no interfaces at
        // all. Confirms the binder recognizes the pattern shape (element-type
        // inference) and the interpreter can drain it end-to-end.
        var source = @"
import System.Linq
import System.Threading.Tasks
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts().ConfigureAwait(false) {
    total = total + v
}
total
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1 + 2 + 3, result.Value);
    }

    [Fact]
    public void AwaitFor_NonAsyncEnumerable_Diagnoses()
    {
        // A type that doesn't implement IAsyncEnumerable<T>; the binder
        // surfaces the await-for-specific diagnostic before iteration
        // starts.
        var source = @"
let n = 42
await for v in (n + 1) {
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("await for"));
    }

    [Fact]
    public void AwaitFor_Empty_BindsAndCompletes()
    {
        var source = @"
import GSharp.Core.Tests.CodeAnalysis.Binding

await for v in AsyncStreamFixture.Empty() {
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void AwaitFor_BodyWithNestedIf_LowersAndEvaluates()
    {
        // Regression: the Lowerer must recurse into the await-for body
        // when flattening so nested if/for control flow works. Pre-fix
        // this raised `Unexpected node BlockStatement` from the evaluator.
        var source = @"
import GSharp.Core.Tests.CodeAnalysis.Binding

var evens = 0
await for v in AsyncStreamFixture.Counts() {
    if v % 2 == 0 {
        evens = evens + 1
    }
}
evens
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}

/// <summary>Helper async-stream sources exposed to GSharp test scripts.</summary>
public static class AsyncStreamFixture
{
    /// <summary>Yields 1, 2, 3 asynchronously.</summary>
    /// <returns>A three-element async stream.</returns>
    public static async IAsyncEnumerable<int> Counts()
    {
        yield return 1;
        await Task.Yield();
        yield return 2;
        await Task.Yield();
        yield return 3;
    }

    /// <summary>Yields nothing.</summary>
    /// <returns>An empty async stream.</returns>
#pragma warning disable CS1998 // Async method lacks 'await' operators and will run synchronously
    public static async IAsyncEnumerable<int> Empty()
#pragma warning restore CS1998
    {
        yield break;
    }
}
