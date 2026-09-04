// <copyright file="Issue3319StructLocalZeroValueEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3319 (part of #3163, ADR-0159 follow-up): a struct-typed local
/// (or global, or field) declared without an initializer did not recurse
/// into its OWN magic-collection-typed fields (map/slice/array/sequence) to
/// apply their #3310/ADR-0159 sound zero value — <c>var s S</c> where
/// <c>S</c> has e.g. a bare <c>[]int32</c> field left that field CLR-default
/// null, NRE'ing on first use, unlike the already-working top-level case
/// (<c>var x []int32</c>). <see cref="MagicCollectionZeroValue"/> gains a
/// recursive case for a non-class, non-inline struct type, reused uniformly
/// by every existing consumer of
/// <c>MagicCollectionZeroValue.TrySynthesizeEmptyInstance</c> — so this file
/// also covers the issue's class-nesting audit (a struct-typed field
/// INSIDE a class) and struct-in-struct nesting, plus composition with
/// #3219's private-field ctor-synthesis trigger.
/// </summary>
public class Issue3319StructLocalZeroValueEmitTests
{
    [Fact]
    public void Issue3319_ExactRepro_BareStructLocal_SliceField_IsEmptyNotNil()
    {
        // The issue's own repro: this NRE'd on main.
        var result = EmittedOracle.Evaluate("""
            package P3319Repro

            struct S {
                public var Items []int32
            }

            func run() int32 {
                var s S
                return s.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BareStructLocal_MapField_IsEmptyNotNil()
    {
        var result = EmittedOracle.Evaluate("""
            package P3319MapField


            struct S {
                public var M map[string, int32]
            }

            func run() int32 {
                var s S
                s.M["a"] = 1
                return s.M.Count
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void BareStructLocal_FixedArrayField_HasLengthN()
    {
        var result = EmittedOracle.Evaluate("""
            package P3319ArrayField

            struct S {
                public var A [3]int32
            }

            func run() int32 {
                var s S
                s.A[2] = 9
                return s.A.Length * 10 + s.A[2]
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(39, result.Value);
    }

    [Fact]
    public void BareStructLocal_SequenceField_IteratesAsEmpty()
    {
        var result = EmittedOracle.Evaluate("""
            package P3319SequenceField

            struct S {
                public var Q sequence[int32]
            }

            func run() int32 {
                var s S
                var n = 0
                for v in s.Q {
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
    public void StructInStructNesting_BareOuterLocal_InnerSliceFieldIsEmpty()
    {
        // Struct-in-struct: Outer's field Inner is itself a struct with a
        // magic-collection field — the recursion must reach two levels deep.
        var result = EmittedOracle.Evaluate("""
            package P3319StructInStruct

            struct Inner {
                public var Items []int32
            }

            struct Outer {
                public var I Inner
            }

            func run() int32 {
                var o Outer
                return o.I.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void ThreeLevelStructNesting_SliceFieldIsEmpty()
    {
        var result = EmittedOracle.Evaluate("""
            package P3319ThreeLevel

            struct Leaf {
                public var Items []int32
            }

            struct Mid {
                public var L Leaf
            }

            struct Top {
                public var M Mid
            }

            func run() int32 {
                var t Top
                return t.M.L.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void ClassNestingAudit_ClassFieldOfStructType_ConstructedInstance_SliceFieldIsEmpty()
    {
        // The issue's audit question: does a struct-typed field INSIDE a
        // class get its own field defaults applied, or only the class's own
        // directly-declared fields? Before #3319, only the latter — this is
        // the exact gap the issue asked to audit and fix.
        var result = EmittedOracle.Evaluate("""
            package P3319ClassNesting

            struct Slotted {
                public var Items []int32
            }

            class Holder {
                public var Slot Slotted
            }

            func run() int32 {
                var h = Holder()
                return h.Slot.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void PrivateFieldExplicitInitializer_ComposesWithPublicZeroValueField_Issue3219Ctor()
    {
        // A struct that ALSO needs #3219's synthesized ctor for an unrelated
        // reason (a private field with an EXPLICIT initializer) must still
        // correctly compose with the new zero-value ctor trigger: the
        // private field keeps its explicit value, the public field gets its
        // sound zero value, both via the same synthesized ctor.
        var result = EmittedOracle.Evaluate("""
            package P3319PrivateComposition

            struct WithPrivateInit {
                private var Count int32 = 5
                public var Items []int32

                public func CountValue() int32 {
                    return this.Count
                }
            }

            func run() int32 {
                var s = WithPrivateInit{}
                return s.CountValue() * 100 + s.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(500, result.Value);
    }

    [Fact]
    public void PrivateNonPublicFieldZeroValue_TriggersOwnCtor_BareLocalAndLiteral()
    {
        // A struct whose ONLY field needing a zero value is itself NON-public
        // (private): #3319 composing with #3219 must route construction
        // through the struct's own synthesized ctor rather than attempting
        // an illegal external store into the private field.
        var result = EmittedOracle.Evaluate("""
            package P3319PrivateOnlyField

            struct Slotted {
                public var Items []int32
            }

            struct PrivateNested {
                private var Inner Slotted

                public func InnerLen() int32 {
                    return this.Inner.Items.Length
                }
            }

            func run() int32 {
                var pn PrivateNested
                var pn2 = PrivateNested{}
                return pn.InnerLen() * 10 + pn2.InnerLen()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void OuterOfPrivateNestedField_BareLocal_RoutesThroughInnerCtor()
    {
        // The trickiest composition: a PUBLIC field (OuterOfPrivateNested.PN)
        // whose type (PrivateNested) itself needs #3219's ctor for a
        // DIFFERENT (private) field. The bare outer declaration's
        // recursively-synthesized nested struct literal must emit an
        // EMPTY-initializer literal for PrivateNested (not explicit field
        // stores) so MethodBodyEmitter.EmitStructLiteral routes through
        // PrivateNested's own `call .ctor()` instead of attempting an
        // illegal external stfld into its private field.
        var result = EmittedOracle.Evaluate("""
            package P3319OuterOfPrivateNested

            struct Slotted {
                public var Items []int32
            }

            struct PrivateNested {
                private var Inner Slotted

                public func InnerLen() int32 {
                    return this.Inner.Items.Length
                }
            }

            struct OuterOfPrivateNested {
                public var PN PrivateNested
            }

            func run() int32 {
                var opn OuterOfPrivateNested
                return opn.PN.InnerLen()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void GenericStructField_SliceOfTypeParameter_IsEmptyNotNil()
    {
        var result = EmittedOracle.Evaluate("""
            package P3319GenericStruct

            struct Box[T any] {
                public var Items []T
            }

            func run() int32 {
                var b Box[int32]
                return b.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void UnrelatedPrivateField_NoZeroValueNeeded_PublicSliceFieldStillZeroed()
    {
        // A private field that itself needs NO zero value (a plain int32,
        // no magic type, no explicit initializer) must NOT spuriously
        // trigger #3219's ctor — only a private field that GENUINELY needs
        // one (explicit initializer, or #3319 zero value) does. The public
        // slice field's zero value must still apply either way.
        var result = EmittedOracle.Evaluate("""
            package P3319UnrelatedPrivate

            struct HasUnrelatedPrivate {
                private var X int32
                public var Items []int32
            }

            func run() int32 {
                var s HasUnrelatedPrivate
                return s.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void SharedStaticStructField_NestedSliceField_IsEmptyNotNil()
    {
        // Static/`shared` fields of struct type (not just instance fields)
        // must ALSO get the recursive treatment, through the same
        // MightNeedZeroValue probe + deferred-pass synthesis used for
        // instance fields.
        var result = EmittedOracle.Evaluate("""
            package P3319SharedStructField

            struct Leaf {
                public var Items []int32
            }

            struct HasSharedStructField {
                shared {
                    public var Shared Leaf
                }
            }

            func run() int32 {
                return HasSharedStructField.Shared.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void ExplicitDefaultSpelling_StructLocal_StillNull_HonestyClauseUnchanged()
    {
        // ADR-0159's explicit `= default` honesty clause is unchanged by
        // #3319: it still keeps its literal CLR meaning even for a struct's
        // magic-collection fields. Only an OMITTED initializer gets the
        // sound zero value; `= default` is the deliberate opt-out.
        var result = EmittedOracle.Evaluate("""
            package P3319ExplicitDefault

            struct S {
                public var Items []int32
            }

            func run() bool {
                var s S = default
                return s.Items == nil
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NonMagicExplicitFieldInitializer_StillBypassedForBareDeclaration()
    {
        // The narrower, unchanged half of the honesty clause: a NON-magic
        // field's EXPLICIT initializer still does not run for a bare
        // declaration, at any nesting depth — only the magic-collection
        // zero value is synthesized. A public field keeps this observable
        // (a private field's explicit initializer is exercised indirectly
        // via the #3219-composition tests above, since it cannot be read
        // from outside the struct).
        var result = EmittedOracle.Evaluate("""
            package P3319NonMagicBypassed

            struct S {
                public var Count int32 = 5
                public var Items []int32
            }

            func run() int32 {
                var s S
                return s.Count * 100 + s.Items.Length
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(0, result.Value);
    }
}
