// <copyright file="Issue3329CrossCellStructLiteralReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System.Text
import Xunit

/// Issue #3329 (part of #3163, discovered while verifying #3319): a struct
/// literal (`S{}`) constructed for a struct TYPE declared in an EARLIER
/// REPL submission NREs at runtime — `EmitStructLiteral`'s
/// `structLiteralSlots`/`ResolveUserTypeToken`/
/// `ResolveUserCtorTokenForDefault` machinery does not correctly resolve
/// a cross-submission `StructSymbol`'s type/ctor token, unlike
/// `BoundDefaultExpression`/`initobj`, which already handles it.
class Issue3329CrossCellStructLiteralReplTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructorOwnedDataStruct_SameAndCrossCellPhases(crossCell bool) {
        using let engine = EmittedSessionEngine()
        const declarations = `class Effects {
    shared {
        public var Trace string = ""
        public func Mark(mark string, value int32) int32 {
            Trace = Trace + mark
            return value
        }
    }
}
data struct S {
    public var X int32 = Effects.Mark("D", 7)
}
data struct P(A int32, B int32 = 5) {
    public var X int32 = Effects.Mark("D", 7)
}
`
        const use = `let first = S{X: Effects.Mark("E", 9)}
let firstTrace = Effects.Trace + ":" + first.X.ToString()
Effects.Trace = ""
let second = P{A: Effects.Mark("A", 3), X: Effects.Mark("E", 9)}
let secondTrace = Effects.Trace + ":" + second.A.ToString() + "/" + second.B.ToString() + "/" + second.X.ToString()
Effects.Trace = ""
let copied = first with{X = Effects.Mark("C", 8)}
let raw = default(S)
firstTrace + "|" + secondTrace + "|" + Effects.Trace + ":" + copied.X.ToString() + "/" + raw.X.ToString()`
        if crossCell {
            AssertOk(engine, declarations)
        }
        let result = engine.Evaluate(
            if crossCell {
                use
            } else {
                declarations + use
            }
        )
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(Encoding.UTF8.GetBytes("DE:9|ADE:3/0/9|C:8/0"), Encoding.UTF8.GetBytes(cast[string](result.Value)))
    }

    @Fact
    func CrossCell_BareDeclaration_InitobjOnly_Works() {
        // Control case: no BoundStructLiteralExpression node at all — pure
        // `initobj`. Must stay working (regression pin).
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct S {
    public var X int32
}`)
        let probe = engine.Evaluate("var s S\ns.X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    @Fact
    func CrossCell_EmptyStructLiteral_MagicCollectionField_Works() {
        // Issue #3329's exact magic-collection-field repro.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct S {
    public var Items []int32
}`)
        let probe = engine.Evaluate("var s = S{}\ns.Items.Length")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    @Fact
    func CrossCell_EmptyStructLiteral_ZeroFieldsInvolved_Works() {
        // Issue #3329's minimal repro: no magic-collection field at all.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct S {
    public var X int32
}`)
        let probe = engine.Evaluate("var s = S{}\ns.X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    @Fact
    func CrossCell_StructLiteral_WithExplicitFieldInitializer_Works() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct S {
    public var X int32
}`)
        let probe = engine.Evaluate("var s = S{X: 5}\ns.X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(5, probe.Value)
    }

    @Fact
    func CrossCell_NestedStructInStruct_BothDeclaredEarlier_LiteralWorks() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct Inner {
    public var X int32
}

struct Outer {
    public var I Inner
}`)
        let probe = engine.Evaluate("var o = Outer{}\no.I.X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    @Fact
    func CrossCell_NestedStructInStruct_InnerDeclaredLater_LiteralWorks() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct Outer {
    public var I Inner
}

struct Inner {
    public var X int32
}`)
        let probe = engine.Evaluate("var o = Outer{}\no.I.X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    @Fact
    func CrossCell_StructLiteral_AsCallArgument_Works() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct S {
    public var X int32
}

func GetX(s S) int32 {
    return s.X
}`)
        let probe = engine.Evaluate("GetX(S{X: 3})")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(3, probe.Value)
    }

    @Fact
    func CrossCell_StructLiteral_AsReturnValue_Works() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct S {
    public var X int32
}

func MakeS() S {
    return S{X: 9}
}`)
        let probe = engine.Evaluate("MakeS().X")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(9, probe.Value)
    }

    @Fact
    func SameCell_StructLiteral_RegressionPin() {
        // Same-cell struct literal must stay working — declared and
        // constructed within a single submission's own assembly.
        using let engine = EmittedSessionEngine()
        let result = engine.Evaluate(`struct S {
    public var X int32
}

var s = S{X: 42}
s.X`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func CrossCell_DataStruct_EmptyStructLiteral_MagicCollectionField_Works() {
        // The semantic-aggregate path (data struct / primary-ctor struct)
        // has the SAME gap as the plain-struct fallback path exercised by
        // CrossCell_EmptyStructLiteral_MagicCollectionField_Works above —
        // ImportedTypeSymbol.BuildSemanticAggregate never reconstructed
        // InstanceFieldInitializers either.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `data struct S {
    public var Items []int32
}`)
        let probe = engine.Evaluate("var s = S{}\ns.Items.Length")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(0, probe.Value)
    }

    shared {
        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        }
    }
}
