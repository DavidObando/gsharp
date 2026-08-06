// <copyright file="Issue3292InPlaceElementWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3292: shared-path (compiled) witnesses for in-place
/// (<c>ldelema</c>-rooted) struct member writes through indexed array/slice
/// elements. Unlike the REPL-engine matrix in Interpreter.Tests, these run
/// the real emitter end to end as ordinary compiled programs, pinning the
/// shapes issue #3292 lifts from GS0499 (field writes: simple, compound,
/// increment, nested; mutating method receivers), the once-only evaluation
/// of side-effecting index expressions, and the arms that intentionally
/// keep their old behavior (map elements: GS0499; function-result struct
/// receivers: GS0499).
/// </summary>
public class Issue3292InPlaceElementWriteEmitTests
{
    [Fact]
    public void ArrayElementFieldWrite_MutatesInPlace()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292Simple

            struct P {
                var X int32
            }

            var ps = [2]P{}
            ps[0].X = 7
            ps[0].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ArrayElementFieldCompoundAndIncrement_MutateInPlace()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292Compound

            struct P {
                var X int32
            }

            var ps = [2]P{}
            ps[0].X = 7
            ps[0].X += 3
            ps[0].X++
            ps[0].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void NestedStructChainThroughElement_MutatesInPlace()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292Nested

            struct B {
                var C int32
            }

            struct A2 {
                var B2 B
            }

            var qs = [2]A2{}
            qs[0].B2.C = 42
            qs[0].B2.C
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void SliceElementFieldWrite_MutatesInPlace()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292Slice

            struct P {
                var X int32
            }

            var ss = []P{P{}, P{}}
            ss[1].X = 9
            ss[1].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void MutatingMethodOnArrayElement_MutatesInPlace()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292Method

            struct P {
                var X int32

                func Bump() {
                    this.X = this.X + 1
                }
            }

            var ps = [2]P{}
            ps[1].Bump()
            ps[1].Bump()
            ps[1].X
            """);

        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void CompoundWrite_EvaluatesSideEffectingIndexExactlyOnce()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292OnceCompound

            struct P {
                var X int32
            }

            var calls = 0

            func idx() int32 {
                calls = calls + 1
                return 0
            }

            var ps = [2]P{}
            ps[idx()].X += 5
            calls * 100 + ps[0].X
            """);

        Assert.Equal(105, result.Value);
    }

    [Fact]
    public void SimpleWrite_EvaluatesSideEffectingIndexExactlyOnce()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292OnceSimple

            struct P {
                var X int32
            }

            var calls = 0

            func idx() int32 {
                calls = calls + 1
                return 0
            }

            var ps = [2]P{}
            ps[idx()].X = 11
            calls * 100 + ps[0].X
            """);

        Assert.Equal(111, result.Value);
    }

    [Fact]
    public void NestedCompoundWrite_EvaluatesSideEffectingIndexExactlyOnce()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292OnceNested

            struct B {
                var C int32
            }

            struct A2 {
                var B2 B
            }

            var calls = 0

            func idx() int32 {
                calls = calls + 1
                return 0
            }

            var ns = [2]A2{}
            ns[idx()].B2.C += 8
            calls * 100 + ns[0].B2.C
            """);

        Assert.Equal(108, result.Value);
    }

    [Fact]
    public void MutatingMethod_EvaluatesSideEffectingIndexExactlyOnce()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292OnceMethod

            struct P {
                var X int32

                func Bump() {
                    this.X = this.X + 1
                }
            }

            var calls = 0

            func idx() int32 {
                calls = calls + 1
                return 0
            }

            var ps = [2]P{}
            ps[idx()].Bump()
            calls * 100 + ps[0].X
            """);

        Assert.Equal(101, result.Value);
    }

    [Fact]
    public void MapElementFieldWrite_StillReportsGS0499()
    {
        var result = EmittedOracle.Evaluate("""
            package P3292MapGuard

            struct P {
                var X int32
            }

            var m = map[int32, P]{1: P{}}
            m[1].X = 7
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void FunctionResultStructFieldWrite_StillReportsGS0499()
    {
        // Issue #2818's guard: a struct returned BY VALUE from a call has no
        // storage — only element loads gained addresses, not rvalues.
        var result = EmittedOracle.Evaluate("""
            package P3292RvalueGuard

            struct Item {
                var Id int32
            }

            func MakeItem() Item {
                return Item{Id: 1}
            }

            MakeItem().Id = 7
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void ElementWriteThroughCallResultArrayAlias_IsObservable()
    {
        // The COLLECTION may be an rvalue (call result): the write mutates
        // the heap array it references — C# parity for `Make()[i].X = v`.
        var result = EmittedOracle.Evaluate("""
            package P3292Alias

            struct P {
                var X int32
            }

            var backing = []P{P{}, P{}}

            func grab() []P {
                return backing
            }

            grab()[1].X = 13
            backing[1].X
            """);

        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void LetArrayElementFieldWrite_MutatesHeapArrayInPlace()
    {
        // Issue #1132 shallow-`let`: `ls[0] = v` on a `let` array is legal
        // (heap mutation), so the member write over the same storage is too.
        var result = EmittedOracle.Evaluate("""
            package P3292Let

            struct P {
                var X int32
            }

            let ls = [2]P{}
            ls[0].X = 5
            ls[0].X
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void PropertySetterThroughElement_MutatesInPlace()
    {
        // Previously the receiver spilled to a temp and the setter mutated
        // the copy silently; the element-address receiver fixes it.
        var result = EmittedOracle.Evaluate("""
            package P3292Prop

            struct P {
                var x int32

                prop X int32 {
                    get { return x }
                    set { x = value }
                }
            }

            var ps = [2]P{}
            ps[0].X = 7
            ps[0].x
            """);

        Assert.Equal(7, result.Value);
    }
}
