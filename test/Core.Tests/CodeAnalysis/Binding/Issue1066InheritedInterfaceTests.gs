// <copyright file="Issue1066InheritedInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1066: a class satisfies an interface member when the member is
/// implemented (or inherited) ANYWHERE in its base-class chain — not only when
/// declared directly on the class. Mirrors C# semantics where a base class's
/// accessible instance member satisfies an interface listed on a derived class.
/// The interface-satisfaction check must walk `BaseClass` for both methods
/// and properties (including the property's accessors).
open class Issue1066InheritedInterfaceTests {
    @Fact
    func LeafInheritsProperty_ViaTransitiveInterface_BindsWithNoDiagnostics() {
        // The canonical repro from the issue: IBase requires `prop H`, Base
        // implements it, and Leaf (→ Mid → Base) lists IDerived : IBase.
        const source = `package p
interface IBase { prop H int32 { get; } }
interface IDerived : IBase { }
open class Base : IBase {
    prop H int32 { get; init; }
    init(h int32) { H = h }
}
open class Mid : Base { init(h int32) : base(h) { } }
class Leaf : Mid, IDerived { init(h int32) : base(h) { } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DerivedClassListsInterface_PropertyImplementedOnImmediateBase_BindsClean() {
        // Requirement comes from a directly-listed interface implemented by a
        // base class.
        const source = `package p
interface IBase { prop H int32 { get; } }
open class Base {
    prop H int32 { get; init; }
    init(h int32) { H = h }
}
class Leaf : Base, IBase { init(h int32) : base(h) { } }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func LeafInheritsMethod_ViaTransitiveInterface_BindsWithNoDiagnostics() {
        // Interface METHOD (not just a property) inherited from a base class.
        const source = `package p
interface IBase { func M() int32; }
interface IDerived : IBase { }
open class Base : IBase {
    func M() int32 { return 7 }
}
open class Mid : Base { }
class Leaf : Mid, IDerived { }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenuinelyUnimplementedInterfaceMember_StillReportsGS0187() {
        // Negative guard: neither the class nor any base implements `prop H`.
        const source = `package p
interface IBase { prop H int32 { get; } }
open class Base { }
class Leaf : Base, IBase { }`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
