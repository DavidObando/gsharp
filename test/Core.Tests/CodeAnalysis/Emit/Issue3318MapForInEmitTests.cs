// <copyright file="Issue3318MapForInEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3318 (part of #3163): range-<c>for</c> iteration over
/// <c>map[K, V]</c>. Pre-fix, both loop forms failed at bind time with
/// GS0116 ("Type 'map[K,V]' is not indexable") because the binder's
/// range-for operand classification had no map arm — maps were the only
/// major collection <c>for … in</c> could not iterate.
///
/// <para><b>Decided semantics</b> (C#/Kotlin entry parity — Go's
/// yield-keys single-variable form is explicitly rejected so cs2gs's
/// <c>foreach</c>-over-Dictionary translation stays faithful):
/// the two-variable form <c>for k, v in m</c> destructures entries into
/// <c>k: K</c>, <c>v: V</c> (the map analog of the slice/array
/// index+value form); the single-variable form <c>for kv in m</c> binds
/// the whole <c>KeyValuePair[K, V]</c> element (#1328 dictionary
/// semantics). Iteration order is unspecified — every assertion below is
/// order-independent. Inserting a new key while iterating surfaces the
/// backing Dictionary's "Collection was modified" exception, pinned here
/// as the defined behavior.</para>
/// </summary>
public class Issue3318MapForInEmitTests
{
    // ---------------------------------------------------------------
    // Concrete maps — both forms.
    // ---------------------------------------------------------------

    [Fact]
    public void TwoVar_ConcreteMap_Destructures_Key_And_Value()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318TwoVar

            func run() int32 {
                var m = map[int32, int32]{1: 10, 2: 20, 3: 30}
                var keySum = 0
                var valSum = 0
                for k, v in m {
                    keySum = keySum + k
                    valSum = valSum + v
                }
                return keySum * 100 + valSum
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(660, result.Value);
    }

    [Fact]
    public void TwoVar_ConcreteMap_StringKeys_Binds_K_And_V_Statically()
    {
        // k must bind as string (usable with +) and v as int32
        // (usable in arithmetic) — not object.
        var result = EmittedOracle.Evaluate("""
            package P3318TwoVarTypes

            func run() int32 {
                var m = map[string, int32]{"a": 1, "bb": 2}
                var n = 0
                for k, v in m {
                    n = n + k.Length * v
                }
                return n
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void OneVar_ConcreteMap_Binds_KeyValuePair_Element()
    {
        // `for kv in m` yields KeyValuePair[K, V] — .Key/.Value member
        // access must recover the static K and V types.
        var result = EmittedOracle.Evaluate("""
            package P3318OneVar

            func run() int32 {
                var m = map[int32, int32]{1: 10, 2: 20, 3: 30}
                var total = 0
                for kv in m {
                    total = total + kv.Key * 1000 + kv.Value
                }
                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(6060, result.Value);
    }

    [Fact]
    public void Empty_Map_Iterates_Zero_Times_Both_Forms()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318Empty

            func run() int32 {
                var m = map[string, int32]{}
                var n = 100
                for k, v in m {
                    n = n + v
                }
                for kv in m {
                    n = n + kv.Value
                }
                return n
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(100, result.Value);
    }

    [Fact]
    public void ZeroValue_Map_Declaration_Iterates_Zero_Times()
    {
        // ADR-0159: an initializer-less map is a sound empty instance —
        // iterating it must be a no-op, not a crash.
        var result = EmittedOracle.Evaluate("""
            package P3318ZeroValue

            func run() int32 {
                var m map[int32, string]
                var n = 7
                for k, v in m {
                    n = n + k
                }
                return n
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(7, result.Value);
    }

    // ---------------------------------------------------------------
    // Control flow: nested loops, break, continue, labeled break.
    // ---------------------------------------------------------------

    [Fact]
    public void Nested_Map_Loops_Iterate_Cross_Product()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318Nested

            func run() int32 {
                var outer = map[int32, int32]{1: 100, 2: 200}
                var inner = map[int32, int32]{3: 1, 4: 2}
                var total = 0
                for k1, v1 in outer {
                    for k2, v2 in inner {
                        total = total + v1 * v2 + k1 + k2
                    }
                }
                return total
            }

            run()
            """);

        // v1*v2 over cross product: 100*1+100*2+200*1+200*2 = 900.
        // keys: (1+3)+(1+4)+(2+3)+(2+4) = 20. Total 920.
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(920, result.Value);
    }

    [Fact]
    public void Break_Exits_Map_Loop_Early()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318Break

            func run() int32 {
                var m = map[int32, int32]{1: 1, 2: 2, 3: 3, 4: 4}
                var iterations = 0
                for k, v in m {
                    iterations = iterations + 1
                    if iterations == 2 {
                        break
                    }
                }
                return iterations
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void Continue_Skips_Map_Entries()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318Continue

            func run() int32 {
                var m = map[int32, int32]{1: 10, 2: 20, 3: 30, 4: 40}
                var total = 0
                for k, v in m {
                    if k % 2 == 0 {
                        continue
                    }
                    total = total + v
                }
                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(40, result.Value);
    }

    [Fact]
    public void Labeled_Break_Exits_Outer_Map_Loop()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318LabeledBreak

            func run() int32 {
                var outer = map[int32, int32]{1: 1, 2: 2}
                var inner = map[int32, int32]{3: 3, 4: 4}
                var n = 0
                outerLoop: for k1, v1 in outer {
                    for k2, v2 in inner {
                        n = n + 1
                        break outerLoop
                    }
                }
                return n
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }

    // ---------------------------------------------------------------
    // Open-generic maps (K and/or V are in-scope type parameters):
    // the #3313 symbolic Dictionary-view machinery must carry the
    // loop element as KeyValuePair[K, V] from day one.
    // ---------------------------------------------------------------

    [Fact]
    public void GenericFunc_TwoVar_OpenMap_Recovers_Symbolic_K_And_V()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318OpenTwoVar

            func Roundtrip[K any, V any](items map[K, V]) map[K, V] {
                var copy = map[K, V]{}
                for k, v in items {
                    copy[k] = v
                }
                return copy
            }

            func run() int32 {
                var m = map[string, int32]{"a": 1, "b": 2}
                var c = Roundtrip[string, int32](m)
                return c["a"] * 10 + c["b"]
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void GenericFunc_OneVar_OpenMap_Element_Is_Symbolic_KeyValuePair()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318OpenOneVar

            func FirstValueOr[K any, V any](items map[K, V], fb V) V {
                for kv in items {
                    return kv.Value
                }
                return fb
            }

            func run() int32 {
                var m = map[string, int32]{"only": 42}
                var empty = map[string, int32]{}
                return FirstValueOr[string, int32](m, 0) + FirstValueOr[string, int32](empty, 1)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(43, result.Value);
    }

    [Fact]
    public void GenericFunc_TwoVar_MixedOpenMap_CountsEntries()
    {
        // MIXED instantiation: concrete key, open value.
        var result = EmittedOracle.Evaluate("""
            package P3318OpenMixed

            func SumKeysTimesCount[V any](items map[int32, V]) int32 {
                var keySum = 0
                var count = 0
                for k, v in items {
                    keySum = keySum + k
                    count = count + 1
                }
                return keySum * 10 + count
            }

            func run() int32 {
                var m = map[int32, string]{1: "a", 2: "b", 4: "c"}
                return SumKeysTimesCount[string](m)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(73, result.Value);
    }

    [Fact]
    public void GenericClass_Field_Map_TwoVar_Iteration()
    {
        // Open map stored as a generic class field (the #3303/#3311
        // container shape) must iterate inside a method of that class.
        var result = EmittedOracle.Evaluate("""
            package P3318OpenField

            class Counter[K any] {
                var hits map[K, int32]
                init() { hits = map[K, int32]{} }
                func Hit(k K) { hits[k] = (hits.ContainsKey(k) ? hits[k] : 0) + 1 }
                func Total() int32 {
                    var n = 0
                    for k, v in hits {
                        n = n + v
                    }
                    return n
                }
            }

            func run() int32 {
                var c = Counter[string]()
                c.Hit("a")
                c.Hit("b")
                c.Hit("a")
                return c.Total()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(3, result.Value);
    }

    // ---------------------------------------------------------------
    // User-declared K and V.
    // ---------------------------------------------------------------

    [Fact]
    public void Map_With_UserStruct_Value_Iterates_And_Reads_Fields()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318UserValue

            data struct Point {
                var X int32
                var Y int32
            }

            func run() int32 {
                var m = map[string, Point]{"a": Point{X: 1, Y: 2}, "b": Point{X: 3, Y: 4}}
                var total = 0
                for k, v in m {
                    total = total + v.X + v.Y
                }
                for kv in m {
                    total = total + kv.Value.X
                }
                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(14, result.Value);
    }

    [Fact]
    public void Map_With_UserStruct_Key_Iterates_And_Reads_Key_Fields()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318UserKey

            data struct Id {
                var N int32
            }

            func run() int32 {
                var m = map[Id, string]{Id{N: 3}: "x", Id{N: 4}: "yy"}
                var total = 0
                for k, v in m {
                    total = total + k.N * v.Length
                }
                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(11, result.Value);
    }

    // ---------------------------------------------------------------
    // Mutation during iteration: inserting a new key surfaces the
    // backing Dictionary's InvalidOperationException — the defined
    // behavior (spec-noted).
    // ---------------------------------------------------------------

    [Fact]
    public void Inserting_New_Key_During_Iteration_Throws_CollectionWasModified()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318Mutate

            func run() int32 {
                var m = map[int32, int32]{1: 1, 2: 2}
                var n = 0
                for k, v in m {
                    m[k + 100] = v
                    n = n + 1
                }
                return n
            }

            run()
            """);

        Assert.NotNull(result.UnhandledException);
        Assert.IsType<System.InvalidOperationException>(result.UnhandledException);
        Assert.Contains("Collection was modified", result.UnhandledException.Message);
    }

    // ---------------------------------------------------------------
    // The slice parallel: two-var over a slice stays index+value —
    // map's key+value form is the analog, not a change in the
    // existing meaning.
    // ---------------------------------------------------------------

    [Fact]
    public void TwoVar_Slice_Form_Stays_Index_And_Value()
    {
        var result = EmittedOracle.Evaluate("""
            package P3318SliceParallel

            func run() int32 {
                var s = []int32{10, 20, 30}
                var total = 0
                for i, v in s {
                    total = total + i * 1000 + v
                }
                return total
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(3060, result.Value);
    }
}
