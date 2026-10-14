// <copyright file="Adr0149ExplicitInterfaceClauseBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import Xunit

/// ADR-0149: binder-level diagnostics for the explicit-interface qualifier
/// clause (`func (X) M(...)` / `prop (X) P T` / `prop (X)
/// this[...] T`), plus the coexistence and indexer behaviors the clause
/// enables. See `Issue2010ExplicitInterfaceImplEmitTests`,
/// `Issue2181GenericExplicitInterfaceImplEmitTests`, and
/// `Issue2362ExplicitInterfacePropertyEmitTests` for the emit-level
/// (MethodImpl / metadata-name / runtime-dispatch) coverage of the same
/// clause; these tests focus on
/// (cref:GSharp.Core.CodeAnalysis.Binding.DeclarationBinder.ResolveExplicitInterfaceClauses)
/// and `VerifyExplicitInterfaceClauseResolution`'s own diagnostics.
open class Adr0149ExplicitInterfaceClauseBinderTests {
    @Fact
    func ClauseReferencesNonInterfaceType_ReportsGS0492() {
        let source = `
package P

class NotAnInterface { }

class Host {
    private func (NotAnInterface) M() int32 { return 1 }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0492")
    }

    @Fact
    func PropertyClauseReferencesNonInterfaceType_ReportsGS0492() {
        let source = `
package P

class NotAnInterface { }

class Host {
    private prop (NotAnInterface) P int32 -> 1
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0492")
    }

    @Fact
    func ClauseReferencesUnimplementedInterface_ReportsGS0493() {
        let source = `
package P

interface IBar {
    func M() int32;
}

interface IOther {
    func M() int32;
}

class Host : IBar {
    func M() int32 { return 1 }

    private func (IOther) M() int32 { return 2 }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0493")
    }

    @Fact
    func ClauseReferencesInterfaceWithNoMatchingMember_ReportsGS0494() {
        let source = `
package P

interface IFoo {
    prop Bar string { get; }
}

class Impl : IFoo {
    prop Bar string -> "impl"

    private prop (IFoo) Baz string -> "x"
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0494")
    }

    @Fact
    func TwoMembersClaimSameInterfaceSlot_ReportsGS0495() {
        let source = `
package P

interface IFoo {
    func Bar() int32;
}

class Impl : IFoo {
    private func (IFoo) Bar() int32 { return 1 }

    private func (IFoo) Bar() int32 { return 2 }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0495")
    }

    @Fact
    func TwoPropertiesClaimSameInterfaceSlot_ReportsGS0495() {
        let source = `
package P

interface IFoo {
    prop Bar string { get; }
}

class Impl : IFoo {
    private prop (IFoo) Bar string -> "a"

    private prop (IFoo) Bar string -> "b"
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0495")
    }

    @Fact
    func PublicPropertyAndExplicitClauseProperty_ShareSourceName_NoDiagnostics() {
        // The exact Oahu Authorization/IProfile shape: a plain, implicitly
        // dispatched property and a purely-explicit-slot property may share
        // the same declared source name — this is the entire point of the
        // clause (ADR-0149) and must not be flagged as a duplicate member.
        let source = `
package P

interface IProfile {
    prop Authorization string { get; }
}

class Profile : IProfile {
    prop Authorization string { get; set; }

    private prop (IProfile) Authorization string -> Authorization
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TwoExplicitClausesTargetingDifferentInterfaces_ShareSourceName_NoDiagnostics() {
        let source = `
package P

interface IFoo {
    func Bar() string;
}

interface IBaz {
    func Bar() string;
}

class Both : IFoo, IBaz {
    private func (IFoo) Bar() string { return "foo" }

    private func (IBaz) Bar() string { return "baz" }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IndexerExplicitInterfaceClause_TargetsInterfaceWithoutIndexer_ReportsGS0494() {
        // ADR-0149 (issue #944 follow-up): G# interfaces CAN now declare
        // indexer members — the pre-existing DeclarationBinder rejection of
        // any `prop this[...]` inside an `interface` block has been removed.
        // This test now exercises the ordinary "clause targets an interface
        // with no matching member" case (GS0494) using an interface that
        // legitimately has no indexer at all (`IEmpty` only declares
        // `func Marker()`), confirming that case is unaffected by the new
        // interface-indexer support. See
        // <see cref="IndexerExplicitInterfaceClause_TargetsInterfaceIndexer_NoDiagnostics"/>
        // for the new, fully-supported end-to-end resolution.
        let source = `
package P

interface IEmpty {
    func Marker();
}

class Store : IEmpty {
    func Marker() { }

    prop this[index int32] string { get { return "public" } }

    private prop (IEmpty) this[index int32] string { get { return "explicit" } }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0494")
    }

    @Fact
    func IndexerExplicitInterfaceClause_TargetsInterfaceIndexer_NoDiagnostics() {
        // ADR-0149 (issue #944 follow-up): an interface CAN now declare its
        // own indexer contract, and a class's explicit-interface-clause
        // indexer resolves against it exactly like any other explicit member.
        let source = `
package P

interface IRepo {
    prop this[key string] int32 { get; set }
}

class Store : IRepo {
    private prop (IRepo) this[key string] int32 {
        get { return 1 }
        set { }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TwoIndexersDifferentInterfaces_ShareParameterShape_NoDiagnostics() {
        // ADR-0149 (issue #944 follow-up): two explicit-interface indexer
        // implementations sharing the exact same parameter shape (both
        // `this[string]`) but targeting DIFFERENT interfaces must coexist —
        // exactly like the property/method coexistence case above — closing
        // the gap the old mangled-name convention only partially covered.
        let source = `
package P

interface IRepoA {
    prop this[key string] int32 { get; set }
}

interface IRepoB {
    prop this[key string] int32 { get; set }
}

class Store : IRepoA, IRepoB {
    private prop (IRepoA) this[key string] int32 {
        get { return 1 }
        set { }
    }

    private prop (IRepoB) this[key string] int32 {
        get { return 2 }
        set { }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func EventExplicitInterfaceClause_TargetsInterfaceWithNoMatchingMember_ReportsGS0494() {
        // ADR-0149: generalizes the method/property/indexer clause-resolution
        // sweep to events for the first time.
        let source = `
package P

interface IFoo {
    event Changed () -> void
}

interface IBar {
    event Other () -> void
}

class Impl : IFoo, IBar {
    event (IFoo) Changed () -> void { add { } remove { } }

    private event (IBar) Missing () -> void { add { } remove { } }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0494")
    }

    @Fact
    func EventExplicitInterfaceClause_TargetsInterfaceEvent_NoDiagnostics() {
        let source = `
package P

interface IFoo {
    event Changed () -> void
}

class Impl : IFoo {
    event (IFoo) Changed () -> void { add { } remove { } }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TwoEventsClaimSameInterfaceSlot_ReportsGS0495() {
        let source = `
package P

interface IFoo {
    event Changed () -> void
}

class Impl : IFoo {
    event (IFoo) Changed () -> void { add { } remove { } }

    private event (IFoo) Changed () -> void { add { } remove { } }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0495")
    }

    @Fact
    func PublicEventAndExplicitClauseEvent_ShareSourceName_NoDiagnostics() {
        // Event-level counterpart of the Authorization/IProfile property
        // coexistence case above — a plain, implicitly dispatched event and a
        // purely-explicit-slot event may share the same declared source name.
        let source = `
package P

interface IFoo {
    event Changed () -> void
}

class Impl : IFoo {
    event Changed () -> void { add { } remove { } }

    private event (IFoo) Changed () -> void { add { } remove { } }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TwoExplicitEventClausesTargetingDifferentInterfaces_ShareSourceName_NoDiagnostics() {
        let source = `
package P

interface IFoo {
    event Bar () -> void
}

interface IBaz {
    event Bar () -> void
}

class Both : IFoo, IBaz {
    private event (IFoo) Bar () -> void { add { } remove { } }

    private event (IBaz) Bar () -> void { add { } remove { } }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func OrdinaryDuplicatePlainProperties_StillReportsSymbolAlreadyDeclared() {
        // Two ordinary (non-clause) same-name properties must still be
        // rejected as a duplicate — the ADR-0149 coexistence exemption must
        // not weaken this unrelated, pre-existing check.
        let source = `
package P

class Host {
    prop Greeting string -> "one"
    prop Greeting string -> "two"
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    // ADR-0149 follow-up (issue #2370, "final completion pass"): generalizes
    // the explicit-interface qualifier clause to STATIC methods/properties
    // (C# 11 `static abstract`/`static virtual` interface members,
    // ADR-0089/#755/#1019). See <c>Issue2370ExplicitInterfaceStaticMemberEmitTests</c>
    // for the emit-level (MethodImpl / runtime-dispatch) coverage; these
    // tests focus on the binder diagnostics, mirroring the instance-member
    // tests above exactly but inside a `shared { }` block.
    @Fact
    func StaticClauseReferencesNonInterfaceType_ReportsGS0492() {
        let source = `
package P

class NotAnInterface { }

class Host {
    shared {
        private func (NotAnInterface) M() int32 { return 1 }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0492")
    }

    @Fact
    func StaticClauseReferencesUnimplementedInterface_ReportsGS0493() {
        let source = `
package P

interface IBar {
    shared {
        func M() int32;
    }
}

interface IOther {
    shared {
        func M() int32;
    }
}

class Host : IBar {
    shared {
        func M() int32 { return 1 }

        private func (IOther) M() int32 { return 2 }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0493")
    }

    @Fact
    func StaticClauseReferencesInterfaceWithNoMatchingMember_ReportsGS0494() {
        let source = `
package P

interface IFoo {
    shared {
        prop Bar string { get; }
    }
}

class Impl : IFoo {
    shared {
        prop Bar string -> "impl"

        private prop (IFoo) Baz string -> "x"
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0494")
    }

    @Fact
    func TwoStaticMethodsClaimSameInterfaceSlot_ReportsGS0495() {
        let source = `
package P

interface IFoo {
    shared {
        func Bar() int32;
    }
}

class Impl : IFoo {
    shared {
        private func (IFoo) Bar() int32 { return 1 }

        private func (IFoo) Bar() int32 { return 2 }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0495")
    }

    @Fact
    func TwoStaticPropertiesClaimSameInterfaceSlot_ReportsGS0495() {
        let source = `
package P

interface IFoo {
    shared {
        prop Bar string { get; }
    }
}

class Impl : IFoo {
    shared {
        private prop (IFoo) Bar string -> "a"

        private prop (IFoo) Bar string -> "b"
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0495")
    }

    @Fact
    func StaticPublicMethodAndExplicitClauseMethod_ShareSourceName_NoDiagnostics() {
        // The static counterpart of the Oahu Authorization/IProfile shape: a
        // plain, implicitly-dispatched static method and a purely-explicit-
        // slot static method may share the same declared source name.
        let source = `
package P

interface IFoo {
    shared {
        func Bar() int32;
    }
}

class Impl : IFoo {
    shared {
        func Bar() int32 { return 1 }

        private func (IFoo) Bar() int32 { return 2 }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func TwoStaticExplicitClausesTargetingDifferentInterfaces_ShareSourceName_NoDiagnostics() {
        let source = `
package P

interface IFoo {
    shared {
        func Bar() string;
    }
}

interface IBaz {
    shared {
        func Bar() string;
    }
}

class Both : IFoo, IBaz {
    shared {
        private func (IFoo) Bar() string { return "foo" }

        private func (IBaz) Bar() string { return "baz" }
    }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }
    }
}
