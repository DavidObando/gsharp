// <copyright file="AwaitForRangeStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Threading.Tasks
import Xunit

/// Phase 5.8 / ADR-0023 — `await for v := range stream { … }`
/// over `IAsyncEnumerable[T]`.
open class AwaitForRangeStatementTests {
    @Fact
    func AwaitFor_DrainsAsyncEnumerable() {
        let source = `
import System.Linq
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts() {
    total = total + v
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1 + 2 + 3, result.Value)
    }

    @Fact
    func AwaitFor_ConfigureAwaitFalse_DrainsAsyncEnumerable() {
        // Issue #2280: `stream.ConfigureAwait(false)` returns
        // `ConfiguredCancelableAsyncEnumerable[T]`, a fully duck-typed
        // (pattern-based) async enumerable that implements no interfaces at
        // all. Confirms the binder recognizes the pattern shape (element-type
        // inference) and the emitted oracle can drain it end-to-end.
        let source = `
import System.Linq
import System.Threading.Tasks
import GSharp.Core.Tests.CodeAnalysis.Binding

var total = 0
await for v in AsyncStreamFixture.Counts().ConfigureAwait(false) {
    total = total + v
}
total
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1 + 2 + 3, result.Value)
    }

    @Fact
    func AwaitFor_NonAsyncEnumerable_Diagnoses() {
        // A type that doesn't implement IAsyncEnumerable<T>; the binder
        // surfaces the await-for-specific diagnostic before iteration
        // starts.
        let source = `
let n = 42
await for v in (n + 1) {
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("await for"))
    }

    @Fact
    func AwaitFor_Empty_BindsAndCompletes() {
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

await for v in AsyncStreamFixture.Empty() {
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func AwaitFor_BodyWithNestedIf_LowersAndEvaluates() {
        // Regression: the Lowerer must recurse into the await-for body
        // when flattening so nested if/for control flow works. Pre-fix
        // this raised `Unexpected node BlockStatement` from the evaluator.
        let source = `
import GSharp.Core.Tests.CodeAnalysis.Binding

var evens = 0
await for v in AsyncStreamFixture.Counts() {
    if v % 2 == 0 {
        evens = evens + 1
    }
}
evens
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}

/// Helper async-stream sources exposed to GSharp test scripts.
shared class AsyncStreamFixture {
    /// Yields 1, 2, 3 asynchronously.
    /// @returns A three-element async stream.
    async func Counts() IAsyncEnumerable[int32] {
        yield 1
        await Task.Yield()
        yield 2
        await Task.Yield()
        yield 3
    }

    /// Yields nothing.
    /// @returns An empty async stream.
    async func Empty() IAsyncEnumerable[int32] {
        yield break
    }
}
