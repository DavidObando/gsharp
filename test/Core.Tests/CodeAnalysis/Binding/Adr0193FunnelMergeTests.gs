// <copyright file="Adr0193FunnelMergeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System.Linq
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.Tests
import System

/// ADR-0193 Phase 2 (issue #4363): signature positions that were converted
/// with a bare `TypeSymbol.FromClrType` or an unmerged
/// `MapOpenClrTypeToSymbolic` now go through the funnel readers, so a
/// declaration's `string?` reaches the binder. Each case below compiled
/// with no diagnostic before — the declared `?` was dropped, so a nil
/// value flowed into a non-null `string` unchecked.
class Adr0193FunnelMergeTests {
    @Fact
    func PatternEnumeratorCurrentKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

func Take(items NullableItems) {
    for item in items {
        let s string = item
    }
}`)
    }

    @Fact
    func AsyncPatternEnumeratorCurrentKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

async func Take(items NullableAsyncItems) {
    await for item in items {
        let s string = item
    }
}`)
    }

    @Fact
    func UserEnumerableThroughAClrEnumeratorKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

class Bag {
    func GetEnumerator() NullableEnumerator -> NullableEnumerator()
}

func Take(bag Bag) {
    for item in bag {
        let s string = item
    }
}`)
    }

    @Fact
    func AwaiterGetResultKeepsItsDeclaredNullability() {
        AssertNullableStringRejected(`import Adr0193Contracts

async func Take(awaitable NullableAwaitable) {
    let s string = await awaitable
}`)
    }

    @Fact
    func InlineOutVarKeepsItsBareShape() {
        // The cs2gs Oahu gate's shape: the out parameter is declared
        // `[NotNullWhen(true)] out Uri? result`, and the result is used after
        // a `bool` guard that does not narrow. The inline local keeps the bare
        // shape it had before Phase 2 (#4363 tracks reading the declared `?`
        // once `out var` narrowing exists).
        let result = EmittedOracle.Evaluate([]string{`import System

func Parse(text string) Uri {
    while true {
        let ok = Uri.TryCreate(text, UriKind.Absolute, out var parsed)
        if !ok {
            continue
        }

        return parsed
    }
}`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private const Contract string = `#nullable enable
namespace Adr0193Contracts
{
    public sealed class NullableItems
    {
        public Enumerator GetEnumerator() => new Enumerator();

        public struct Enumerator
        {
            private int index;

            public bool MoveNext() => index++ < 1;

            public string? Current => null;
        }
    }

    public struct NullableEnumerator
    {
        private int index;

        public bool MoveNext() => index++ < 1;

        public string? Current => null;
    }

    public sealed class NullableAsyncItems
    {
        public AsyncEnumerator GetAsyncEnumerator() => new AsyncEnumerator();

        public struct AsyncEnumerator
        {
            private int index;

            public System.Threading.Tasks.ValueTask<bool> MoveNextAsync()
                => new System.Threading.Tasks.ValueTask<bool>(index++ < 1);

            public string? Current => null;
        }
    }

    public sealed class NullableAwaitable
    {
        public Awaiter GetAwaiter() => new Awaiter();

        public readonly struct Awaiter : System.Runtime.CompilerServices.INotifyCompletion
        {
            public bool IsCompleted => true;

            public string? GetResult() => null;

            public void OnCompleted(System.Action continuation) => continuation();
        }
    }
}`

        private func AssertNullableStringRejected(source string) {
            using let fixture = CSharpFixture(Contract)
            let result = EmittedOracle.Evaluate(
                []string{source},
                EmittedOracleOptions{IsLibrary: true, References: []string{fixture.AssemblyPath}}
            )
            Assert.Contains(
                result.Diagnostics,
                (diagnostic Diagnostic) -> diagnostic.Message.Contains("string?", StringComparison.Ordinal)
            )
        }
    }
}
