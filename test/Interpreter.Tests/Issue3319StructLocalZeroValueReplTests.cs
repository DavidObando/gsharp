// <copyright file="Issue3319StructLocalZeroValueReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3319 (ADR-0159 follow-up, part of #3163) through the session
/// engine: a struct-typed local (or REPL-hoisted global) declared without an
/// initializer now recurses into its own magic-collection-typed fields to
/// apply their sound zero value.
///
/// <para>Cross-cell coverage is deliberately narrower than same-cell: while
/// investigating this issue, constructing a NEW <c>BoundStructLiteralExpression</c>
/// (an EXPLICIT struct literal, e.g. <c>S{}</c>) for a struct TYPE declared
/// in an EARLIER submission and referenced from a LATER one was found to
/// already NRE on main — entirely independent of #3319 (the same failure
/// reproduces with a struct that has no magic-collection field at all, using
/// only the pre-existing #3219/#3314 machinery, and with an explicit `S{}`
/// literal that predates this issue). That is a pre-existing cross-submission
/// struct-literal token/slot-resolution gap in the REPL engine, out of
/// #3319's scope — filed as a follow-up rather than fixed here (see the PR
/// description). The cross-cell tests below instead declare the struct AND
/// its zero-valued global TOGETHER in the first cell (so the
/// #3319-synthesized literal is constructed within that submission's own
/// assembly, the already-working case) and only READ the already-zeroed
/// state from a later cell — which is the actual scenario #3319 needs to
/// guarantee cross-cell (a struct-typed REPL-hoisted global's zero value
/// must persist and stay observable from later cells), without exercising
/// the separate pre-existing gap.</para>
/// </summary>
public sealed class Issue3319StructLocalZeroValueReplTests
{
    [Fact]
    public void SameCell_BareStructLocal_SliceField_UsableImmediately()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            struct S {
                public var Items []int32
            }

            var s S
            s.Items.Length
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void CrossCell_StructAndZeroValuedGlobalDeclaredTogether_ReadFromLaterCell()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var Items []int32
            }

            var g S
            """);

        var probe = engine.Evaluate("g.Items.Length");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    [Fact]
    public void CrossCell_BareStructGlobal_HoistedMapField_MutableFromLaterCell()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var M map[string, int32]
            }

            var g S
            """);

        var mutate = engine.Evaluate("g.M[\"a\"] = 7");
        Assert.False(mutate.HasError, string.Join("; ", mutate.Diagnostics));

        var probe = engine.Evaluate("g.M[\"a\"]");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(7, probe.Value);
    }

    [Fact]
    public void SameCell_StructInStructNesting_InnerSliceFieldEmpty()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            struct Inner {
                public var Items []int32
            }

            struct Outer {
                public var I Inner
            }

            var o Outer
            o.I.Items.Length
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void SameCell_ClassContainingStructField_ConstructedInstance_SliceFieldEmpty()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            struct Slotted {
                public var Items []int32
            }

            class Holder {
                public var Slot Slotted
            }

            var h = Holder()
            h.Slot.Items.Length
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(0, result.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }
}
