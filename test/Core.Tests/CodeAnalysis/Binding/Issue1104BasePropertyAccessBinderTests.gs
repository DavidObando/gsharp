// <copyright file="Issue1104BasePropertyAccessBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// Issue #1104: Emitted-oracle coverage for base property access.
/// Traceability: diagnostics GS0157, GS0383, GS0384 and GS0385.
open class Issue1104BasePropertyAccessBinderTests {
    @Fact
    func BaseDotProperty_Read_BindsWithoutGS0157_AndRunsBaseImplementation() {
        let source = `
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    override prop RenderSize int64 {
        get { return base.RenderSize + 5L }
    }
}

var d = Deriv()
d.RenderSize
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
        // base.RenderSize == 10 (base impl, no recursion), override adds 5 → 15.
        Assert.Equal(15L, result.Value)
    }

    @Fact
    func BaseDotProperty_ReachesGrandparentImplementation() {
        let source = `
open class A {
    open prop Tag int64 {
        get { return 1L }
    }
}

open class B() : A {
}

open class C() : B {
    override prop Tag int64 {
        get { return base.Tag + 40L }
    }
}

var c = C()
c.Tag
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        // B does not override Tag, so base.Tag resolves to A::get_Tag == 1.
        Assert.Equal(41L, result.Value)
    }

    @Fact
    func BaseDotProperty_Write_BindsWithoutGS0157_AndCallsBaseSetter() {
        let source = `
open class Base {
    var stored int64 = 100L
    open prop Stored int64 {
        get { return stored }
        set { stored = value }
    }
}

open class Deriv() : Base {
    func SetBase(v int64) {
        base.Stored = v
    }
    func ReadBase() int64 {
        return base.Stored
    }
}

var d = Deriv()
d.SetBase(42L)
d.ReadBase()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
        Assert.Equal(42L, result.Value)
    }

    @Fact
    func BaseDotProperty_OutsideDerivedInstanceMember_DiagnosticGS0383() {
        let source = `
func standalone() int64 {
    return base.RenderSize
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0383")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
    }

    @Fact
    func BaseDotProperty_NoBaseClass_MemberNotFound_DiagnosticGS0384() {
        // Issue #1260: a class deriving only from System.Object now treats
        // System.Object as its base, so a base property access naming a member
        // that does not exist on object is a member-not-found error (GS0384),
        // not the "no base class" GS0383.
        let source = `
class Solo() {
    func Read() int64 { return base.RenderSize }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
    }

    @Fact
    func BaseDotProperty_MemberNotOnBase_DiagnosticGS0384() {
        let source = `
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    func Read() int64 { return base.NotAProperty }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
    }

    @Fact
    func BracketedBaseProperty_Read_ReachesSpecificAncestor() {
        let source = `
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Mid() : Base {
    override prop RenderSize int64 {
        get { return 99L }
    }
}

open class Deriv() : Mid {
    override prop RenderSize int64 {
        get { return base[Base].RenderSize + base.RenderSize }
    }
}

var d = Deriv()
d.RenderSize
`
        // #3223: emitted — the override accessors reuse (non-Final) slots, so
        // the three-level chain loads and `base[Base]` reaches the grandparent.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
        // base[Base].RenderSize == 10 (grandparent, non-virtual) +
        // base.RenderSize == 99 (immediate base Mid) → 109.
        Assert.Equal(109L, result.Value)
    }

    @Fact
    func BracketedBaseProperty_Write_BindsAndCallsSpecificAncestorSetter() {
        let source = `
open class Base {
    var stored int64 = 100L
    open prop Stored int64 {
        get { return stored }
        set { stored = value }
    }
}

open class Mid() : Base {
}

open class Deriv() : Mid {
    func SetBase(v int64) {
        base[Base].Stored = v
    }
    func ReadBase() int64 {
        return base[Base].Stored
    }
}

var d = Deriv()
d.SetBase(42L)
d.ReadBase()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
        Assert.Equal(42L, result.Value)
    }

    @Fact
    func BracketedBaseProperty_SelectorNotBaseClass_DiagnosticGS0385() {
        let source = `
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Other {
    prop Foo int64 { get { return 1L } }
}

open class Mid() : Base {
    override prop RenderSize int64 {
        get { return base[Other].RenderSize }
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0385")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
    }

    @Fact
    func BracketedBaseProperty_MemberNotOnBase_DiagnosticGS0384() {
        let source = `
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Deriv() : Base {
    func Read() int64 { return base[Base].NotAProperty }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
    }

    @Fact
    func BracketedBaseProperty_Write_SelectorNotBaseClass_DiagnosticGS0385() {
        let source = `
open class Base {
    var stored int64 = 0L
    open prop Stored int64 {
        get { return stored }
        set { stored = value }
    }
}

open class Other {
}

open class Deriv() : Base {
    func SetBad(v int64) {
        base[Other].Stored = v
    }
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0385")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0157")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
