// <copyright file="Adr0193FunnelMergeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0193 Phase 2 (issue #4363): signature positions that were converted
/// with a bare <c>TypeSymbol.FromClrType</c> or an unmerged
/// <c>MapOpenClrTypeToSymbolic</c> now go through the funnel readers, so a
/// declaration's <c>string?</c> reaches the binder. Each case below compiled
/// with no diagnostic before — the declared <c>?</c> was dropped, so a nil
/// value flowed into a non-null <c>string</c> unchecked.
/// </summary>
public sealed class Adr0193FunnelMergeTests
{
    private const string Contract = """
        #nullable enable
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
        }
        """;

    [Fact]
    public void PatternEnumeratorCurrentKeepsItsDeclaredNullability()
    {
        AssertNullableStringRejected("""
            import Adr0193Contracts

            func Take(items NullableItems) {
                for item in items {
                    let s string = item
                }
            }
            """);
    }

    [Fact]
    public void AsyncPatternEnumeratorCurrentKeepsItsDeclaredNullability()
    {
        AssertNullableStringRejected("""
            import Adr0193Contracts

            async func Take(items NullableAsyncItems) {
                await for item in items {
                    let s string = item
                }
            }
            """);
    }

    [Fact]
    public void UserEnumerableThroughAClrEnumeratorKeepsItsDeclaredNullability()
    {
        AssertNullableStringRejected("""
            import Adr0193Contracts

            class Bag {
                func GetEnumerator() NullableEnumerator -> NullableEnumerator()
            }

            func Take(bag Bag) {
                for item in bag {
                    let s string = item
                }
            }
            """);
    }

    [Fact]
    public void AwaiterGetResultKeepsItsDeclaredNullability()
    {
        AssertNullableStringRejected("""
            import Adr0193Contracts

            async func Take(awaitable NullableAwaitable) {
                let s string = await awaitable
            }
            """);
    }

    [Fact]
    public void InlineOutVarKeepsItsBareShape()
    {
        // The cs2gs Oahu gate's shape: the out parameter is declared
        // `[NotNullWhen(true)] out Uri? result`, and the result is used after
        // a `bool` guard that does not narrow. The inline local keeps the bare
        // shape it had before Phase 2 (#4363 tracks reading the declared `?`
        // once `out var` narrowing exists).
        var result = EmittedOracle.Evaluate(
            new[]
            {
                """
                import System

                func Parse(text string) Uri {
                    while true {
                        let ok = Uri.TryCreate(text, UriKind.Absolute, out var parsed)
                        if !ok {
                            continue
                        }

                        return parsed
                    }
                }
                """,
            },
            new EmittedOracleOptions { IsLibrary = true });

        Assert.Empty(result.Diagnostics);
    }

    private static void AssertNullableStringRejected(string source)
    {
        using var fixture = new CSharpFixture(Contract);
        var result = EmittedOracle.Evaluate(
            new[] { source },
            new EmittedOracleOptions { IsLibrary = true, References = new[] { fixture.AssemblyPath } });

        Assert.Contains(
            result.Diagnostics,
            diagnostic => diagnostic.Message.Contains("string?", System.StringComparison.Ordinal));
    }
}
