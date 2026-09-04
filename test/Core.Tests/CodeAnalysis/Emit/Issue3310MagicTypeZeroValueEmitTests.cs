// <copyright file="Issue3310MagicTypeZeroValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3310 / ADR-0159, zero-value half (closes #2262): a
/// declared-without-initializer slot of a magic collection type binds a
/// SOUND EMPTY INSTANCE instead of a null reference — locals, globals,
/// class/struct instance fields, `shared` static fields, monomorphic and
/// open-generic shapes. Channels are carved out (see the GS0520 tests).
/// The honesty clauses (element defaults, the explicit `default` spelling)
/// are pinned as documented limitations. Issue #3319 closed the third
/// original honesty clause — a bare `var s S` value-struct local/global/field
/// now recursively synthesizes sound zero values for magic-collection fields
/// through S's own field closure (see Issue3319StructLocalZeroValueEmitTests)
/// — so only the explicit `= default` spelling remains a documented hole.
/// </summary>
public class Issue3310MagicTypeZeroValueEmitTests
{
    [Fact]
    public void Issue2262_ExactRepro_BareMapLocal_IndexedAssignInLoop()
    {
        // The #2262 repro: `var numbers map[int, long]` then indexed
        // assignment in a loop — this NRE'd (GS9999 in the REPL) on main.
        var result = EmittedOracle.Evaluate("""
            package P2262Repro


            func Fib(i int) long -> if i <= 0 { 0 } else if i == 1 { 1 } else { Fib(i-1)+Fib(i-2) }

            func run() int32 {
                var numbers map[int, long]
                for var i = 1; i <= 20; i++ {
                    numbers[i] = Fib(i)
                }

                return numbers.Count
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void BareMapLocal_IsEmptyNotNil()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310MapZero


            func run() int32 {
                var m map[string, int32]
                if m == nil {
                    return -1
                }

                return m.Count
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BareSliceLocal_IsEmpty_AppendAndLenWork()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310SliceZero


            func run() int32 {
                var xs []int32
                var before = xs.Length
                xs = []int32{7}
                return before * 10 + xs.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void BareFixedArrayLocal_HasLengthN_ElementsWritable()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310ArrZero


            func run() int32 {
                var a [3]int32
                a[2] = 9
                return a.Length * 10 + a[2]
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(39, result.Value);
    }

    [Fact]
    public void BareSequenceLocal_IteratesAsEmpty()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310SeqZero

            func run() int32 {
                var q sequence[int32]
                var n = 0
                for v in q {
                    n = n + 1
                }

                return n
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BareMapGlobal_TopLevel_UsableImmediately()
    {
        // Top-level declarations are hoisted static fields; the synthesized
        // empty instance flows through the same declaration path.
        var result = EmittedOracle.Evaluate("""
            package P3310GlobalZero


            var counts map[string, int32]
            counts["a"] = 1
            counts["b"] = 2
            counts.Count
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ClassInstanceFields_AllKinds_UsableWithoutInit()
    {
        // Monomorphic instance fields of every zero-valued kind, used with
        // NO init() assignment: synthesized field initializers run in the
        // default constructor.
        var result = EmittedOracle.Evaluate("""
            package P3310FieldZero


            class C {
                var m map[string, int32]
                var s []int32
                var a [2]int32
                var q sequence[int32]
            }

            func run() int32 {
                var c = C()
                c.m["a"] = 1
                c.s = []int32{5}
                c.a[1] = 9
                var n = 0
                for v in c.q {
                    n = n + 1
                }

                return c.m.Count * 1000 + c.s.Length * 100 + c.a[1] * 10 + n
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1190, result.Value);
    }

    [Fact]
    public void GenericClassFields_OpenShapes_UsableWithoutInit()
    {
        // The open (null-ClrType) field shapes: map[K, V], []K, sequence[V]
        // over the class's own type parameters — synthesized initializers go
        // through the #1481/#3306 symbolic MemberRef machinery.
        var result = EmittedOracle.Evaluate("""
            package P3310GenericFieldZero


            class G[K, V any] {
                var items map[K, V]
                var xs []K
                var q sequence[V]
                func Use(k K, v V) int32 {
                    items[k] = v
                    xs = []K{k}
                    var n = 0
                    for e in q {
                        n = n + 1
                    }

                    return items.Count * 100 + xs.Length * 10 + n
                }
            }

            func run() int32 {
                var g = G[string, int32]()
                return g.Use("x", 42)
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(110, result.Value);
    }

    [Fact]
    public void SharedStaticMapField_UsableWithoutInit()
    {
        // Initializer-less static collection fields get the synthesized
        // empty instance in the .cctor.
        var result = EmittedOracle.Evaluate("""
            package P3310StaticFieldZero


            class R {
                shared {
                    var registry map[string, int32]
                }
            }

            func run() int32 {
                R.registry["k"] = 3
                return R.registry.Count
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ValueStructLiteral_MapField_UsableWithoutInit()
    {
        // A literal-constructed value struct runs the synthesized field
        // initializers (same mechanism as explicit initializers, #640).
        var result = EmittedOracle.Evaluate("""
            package P3310StructZero


            struct S {
                var m map[string, int32]
            }

            func run() int32 {
                var s = S{}
                s.m["z"] = 1
                return s.m.Count
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ValueStructDefaultInstance_MapField_IsEmptyNotNil()
    {
        // Issue #3319 narrows the ADR-0159 "value-struct default instance"
        // honesty clause: a bare `var s S` value-struct local now recursively
        // synthesizes a sound empty-instance zero value for S's OWN
        // magic-collection fields (mirroring the top-level #2262 case), so
        // this is NO LONGER a documented null hole — only the explicit
        // `= default` spelling still bypasses (see
        // ExplicitDefaultInitializer_StaysClrDefault below). Full struct
        // recursion coverage (nested structs, class-containing-struct,
        // #3219 ctor composition) lives in
        // Issue3319StructLocalZeroValueEmitTests.
        var result = EmittedOracle.Evaluate("""
            package P3310StructDefaultHole

            struct S {
                var m map[string, int32]
            }

            func run() bool {
                var s S
                return s.m == nil
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void ExplicitDefaultInitializer_StaysClrDefault()
    {
        // ADR-0159 honesty clause: the explicit `default` spelling
        // (ADR-0100) keeps its CLR meaning — null for a reference-backed
        // type. The empty-instance rule applies to OMITTED initializers only.
        var result = EmittedOracle.Evaluate("""
            package P3310ExplicitDefault

            var m map[string, int32] = default
            m == nil
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ArrayElementsOfMapType_StayClrDefault_DocumentedHole()
    {
        // ADR-0159 honesty clause (the C# NRT array hole): elements of an
        // allocated array/slice of map type remain CLR-default null — only
        // declaration SLOTS get empty instances, not elements.
        var result = EmittedOracle.Evaluate("""
            package P3310ElementHole

            func run() bool {
                var grid [2]map[string, int32]
                return grid[0] == nil
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullableMapSlot_KeepsNullZeroValue()
    {
        // The `?` spelling opts back into the nullable zero: a bare
        // `map[K, V]?` slot without an initializer is nil (ADR-0104
        // unchanged).
        var result = EmittedOracle.Evaluate("""
            package P3310NullableZero

            var m map[string, int32]?
            m == nil
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericSequenceField_AssignEmptySliceLiteral_Binds()
    {
        // The #3310 conversion arm: `q = []K{}` into a `sequence[K]` slot
        // reported GS0155 on main when K is an in-scope type parameter
        // (the monomorphic equivalent already bound through the CLR-backed
        // rules). Needed by the synthesized empty-sequence zero value and
        // now available to user code.
        var result = EmittedOracle.Evaluate("""
            package P3310OpenSeqConv

            class G[K any] {
                var q sequence[K]
                init() { q = []K{} }
                func Count() int32 {
                    var n = 0
                    for v in q {
                        n = n + 1
                    }

                    return n
                }
            }

            func run() int32 {
                var g = G[string]()
                return g.Count()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }
}
