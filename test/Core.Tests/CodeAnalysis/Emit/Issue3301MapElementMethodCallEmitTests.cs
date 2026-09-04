// <copyright file="Issue3301MapElementMethodCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3301: method calls (and the other dictionary-backed operations)
/// on a map whose key or value is a same-compilation user struct crashed
/// the emitter with GS9998 (NullReferenceException): every map-operation
/// emit path except the #1481 map literal reflected over
/// <c>MapTypeSymbol.ClrType</c>, which is null while the struct's own
/// TypeDef is still being emitted. These witnesses pin the fixed routing
/// through reified TypeSpec-parented MemberRefs and the chosen semantics:
/// a method call on a map element operates on the copy the indexer read
/// returns (C# parity for <c>dict[k].M()</c>, and G#'s own established
/// rvalue-receiver behavior, e.g. <c>MakeItem().Bump()</c>) — mutations
/// are discarded, unlike the #3292 in-place array/slice element calls.
/// Map element member WRITES keep their GS0499 rejection (#3293).
/// </summary>
public class Issue3301MapElementMethodCallEmitTests
{
    private const string StructAndMapDecls = """
        struct P {
            var X int32

            func Bump() {
                this.X = this.X + 1
            }

            func Get() int32 {
                return this.X
            }

            func Self() P {
                return this
            }
        }

        var m = map[int32, P]{1: P{X: 10}}
        """;

    [Fact]
    public void MutatingMethodOnMapElement_CallsOnCopy_AndDiscardsMutation()
    {
        // The #3301 crash repro: this exact shape produced
        // "GS9998: NullReferenceException" from EmitMapIndexRead.
        var result = EmittedOracle.Evaluate($$"""
            package P3301Mutating

            {{StructAndMapDecls}}
            m[1].Bump()
            m[1].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void NonMutatingMethodOnMapElement_ReturnsElementValue()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3301NonMutating

            {{StructAndMapDecls}}
            m[1].Get()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void ChainedCallThroughMapElement_WorksOnCopies()
    {
        // `m[1].Self().Bump()` — the second receiver is an ordinary struct
        // rvalue (the #409 spill path); the whole chain runs on copies.
        var result = EmittedOracle.Evaluate($$"""
            package P3301Chained

            {{StructAndMapDecls}}
            m[1].Self().Bump()
            m[1].Self().Get() + m[1].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void MutatingMethodCall_EvaluatesSideEffectingKeyExactlyOnce()
    {
        // The #3302 once-only convention: the receiver `m[key()]` spills to
        // a temp exactly once, so the key expression must not re-run.
        var result = EmittedOracle.Evaluate($$"""
            package P3301OnceKey

            {{StructAndMapDecls}}
            var calls = 0

            func key() int32 {
                calls = calls + 1
                return 1
            }

            m[key()].Bump()
            calls * 100 + m[1].X
            """);

        Assert.Equal(110, result.Value);
    }

    [Fact]
    public void MapElementRead_WithStructValue_Works()
    {
        // The same root cause made ANY `m[k]` read over a user-struct value
        // crash — not just method-call receivers.
        var result = EmittedOracle.Evaluate($$"""
            package P3301Read

            {{StructAndMapDecls}}
            var copy = m[1]
            copy.X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void MapWholeElementWrite_WithStructValue_Works()
    {
        // Whole-element assignment `m[k] = v` (the #3251 remedy seam) went
        // through the same null-ClrType reflection and crashed too.
        var result = EmittedOracle.Evaluate($$"""
            package P3301Write

            {{StructAndMapDecls}}
            m[2] = P{X: 7}
            var copy = m[1]
            copy.X = 99
            m[1] = copy
            m[1].X + m[2].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(106, result.Value);
    }

    [Fact]
    public void LenAndDelete_WithStructValue_Work()
    {
        var result = EmittedOracle.Evaluate($$"""
            package P3301LenDelete


            {{StructAndMapDecls}}
            m[2] = P{X: 7}
            let before = m.Count
            m.Remove(2)
            before * 10 + m.Count
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(21, result.Value);
    }

    [Fact]
    public void MapWithStructKey_ReadAndCall_Work()
    {
        // The key side of the TypeSpec is symbolic here (struct K, string V
        // stays a real CLR type on the erased half).
        var result = EmittedOracle.Evaluate("""
            package P3301StructKey

            struct K2 {
                var Id int32
            }

            var m = map[K2, int32]{K2{Id: 1}: 42}
            m[K2{Id: 1}]
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void MapElementFieldWrite_StillReportsGS0499()
    {
        // #3293's guard must not regress: a map element has no address, so
        // direct member WRITES are still rejected — only method calls (which
        // operate on the returned copy, like C#) are allowed.
        var result = EmittedOracle.Evaluate($$"""
            package P3301WriteGuard

            {{StructAndMapDecls}}
            m[1].X = 7
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }
}
