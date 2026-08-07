// <copyright file="Issue3329CrossCellStructLiteralReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3329 (part of #3163, discovered while verifying #3319): a struct
/// literal (<c>S{}</c>) constructed for a struct TYPE declared in an EARLIER
/// REPL submission NREs at runtime — <c>EmitStructLiteral</c>'s
/// <c>structLiteralSlots</c>/<c>ResolveUserTypeToken</c>/
/// <c>ResolveUserCtorTokenForDefault</c> machinery does not correctly resolve
/// a cross-submission <c>StructSymbol</c>'s type/ctor token, unlike
/// <c>BoundDefaultExpression</c>/<c>initobj</c>, which already handles it.
/// </summary>
public sealed class Issue3329CrossCellStructLiteralReplTests
{
    [Fact]
    public void CrossCell_BareDeclaration_InitobjOnly_Works()
    {
        // Control case: no BoundStructLiteralExpression node at all — pure
        // `initobj`. Must stay working (regression pin).
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var X int32
            }
            """);

        var probe = engine.Evaluate("""
            var s S
            s.X
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    [Fact]
    public void CrossCell_EmptyStructLiteral_MagicCollectionField_Works()
    {
        // Issue #3329's exact magic-collection-field repro.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var Items []int32
            }
            """);

        var probe = engine.Evaluate("""
            var s = S{}
            s.Items.Length
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    [Fact]
    public void CrossCell_EmptyStructLiteral_ZeroFieldsInvolved_Works()
    {
        // Issue #3329's minimal repro: no magic-collection field at all.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var X int32
            }
            """);

        var probe = engine.Evaluate("""
            var s = S{}
            s.X
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    [Fact]
    public void CrossCell_StructLiteral_WithExplicitFieldInitializer_Works()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var X int32
            }
            """);

        var probe = engine.Evaluate("""
            var s = S{X: 5}
            s.X
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(5, probe.Value);
    }

    [Fact]
    public void CrossCell_NestedStructInStruct_BothDeclaredEarlier_LiteralWorks()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct Inner {
                public var X int32
            }

            struct Outer {
                public var I Inner
            }
            """);

        var probe = engine.Evaluate("""
            var o = Outer{}
            o.I.X
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    [Fact]
    public void CrossCell_NestedStructInStruct_InnerDeclaredLater_LiteralWorks()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct Outer {
                public var I Inner
            }

            struct Inner {
                public var X int32
            }
            """);

        var probe = engine.Evaluate("""
            var o = Outer{}
            o.I.X
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    [Fact]
    public void CrossCell_StructLiteral_AsCallArgument_Works()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var X int32
            }

            func GetX(s S) int32 {
                return s.X
            }
            """);

        var probe = engine.Evaluate("GetX(S{X: 3})");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(3, probe.Value);
    }

    [Fact]
    public void CrossCell_StructLiteral_AsReturnValue_Works()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct S {
                public var X int32
            }

            func MakeS() S {
                return S{X: 9}
            }
            """);

        var probe = engine.Evaluate("MakeS().X");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(9, probe.Value);
    }

    [Fact]
    public void SameCell_StructLiteral_RegressionPin()
    {
        // Same-cell struct literal must stay working — declared and
        // constructed within a single submission's own assembly.
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            struct S {
                public var X int32
            }

            var s = S{X: 42}
            s.X
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void CrossCell_DataStruct_EmptyStructLiteral_MagicCollectionField_Works()
    {
        // The semantic-aggregate path (data struct / primary-ctor struct)
        // has the SAME gap as the plain-struct fallback path exercised by
        // CrossCell_EmptyStructLiteral_MagicCollectionField_Works above —
        // ImportedTypeSymbol.BuildSemanticAggregate never reconstructed
        // InstanceFieldInitializers either.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            data struct S {
                public var Items []int32
            }
            """);

        var probe = engine.Evaluate("""
            var s = S{}
            s.Items.Length
            """);
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(0, probe.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }
}
