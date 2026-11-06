// <copyright file="Adr0149ExplicitInterfaceClauseBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
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

    @Fact
    func ReListedSymbolicGenericInterfaceOverImportedBase_NoDiagnostics() {
        let source = `
package P
import System.Collections
import System.Collections.Generic
import System.Collections.ObjectModel

class Shape { }
open class Mid[T] : Collection[T] { }
class Shapes : Collection[Shape], IList[Shape], IList { }
class DerivedShapes : Mid[Shape], IList[Shape] { }
class GenericShapes[T] : Collection[T], IList[T] { }
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("class Bad : Collection[Shape], IList[OtherShape] { }")
    @InlineData("class Bad : Collection[Shape], IList[object] { }")
    @InlineData("class Bad : Collection[object], IList[Shape] { }")
    @InlineData("class Bad : Collection[Shape], IComparable[Shape] { }")
    func ReListedSymbolicGenericInterfaceWithMismatchedOrUnimplementedContract_ReportsGS0187(declaration string) {
        let source = (`
package P
import System
import System.Collections.Generic
import System.Collections.ObjectModel

class Shape { }
class OtherShape { }
` + "$declaration")
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func ExplicitBaseInterfaceClauseWithMismatchedSymbolicTypeArgument_ReportsGS0493() {
        let source = `
package P
import System.Collections
import System.Collections.Generic

class Shape { }
class OtherShape { }

class Host : IReadOnlyList[Shape] {
    prop Count int32 -> 0
    prop this[index int32] Shape -> Shape()
    func GetEnumerator() IEnumerator[Shape] { return List[Shape]().GetEnumerator() }
    private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
    private func (IEnumerable[OtherShape]) GetEnumerator() IEnumerator[OtherShape] { return List[OtherShape]().GetEnumerator() }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0493")
    }

    @Fact
    func SymbolicGenericInterfaceIndexer_IsNotSatisfiedByItemField_ReportsGS0187() {
        let source = `
package P
import System.Collections
import System.Collections.Generic

class Shape { }

class Bad : IReadOnlyList[Shape] {
    public var Item Shape = Shape()
    prop Count int32 -> 0
    func GetEnumerator() IEnumerator[Shape] { return List[Shape]().GetEnumerator() }
    private func (IEnumerable) GetEnumerator() IEnumerator { return GetEnumerator() }
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0187" && d.Message.Contains("Item"))
    }

    /// Issue #4627: a static generic method on a constructed generic receiver
    /// (`ImmutableArray[Base].CastUp(derivedItems)`) infers its method type
    /// argument `TDerived` from a same-compilation derived type and projects
    /// both its parameter and return types symbolically.
    @Fact
    func Issue4627_StaticGenericMethodOnConstructedGenericType_InfersMethodTypeArgument() {
        let source = `
package P
import System.Collections.Immutable

open class BaseSym { }
class DerivedSym : BaseSym { }

func Upcast(items ImmutableArray[DerivedSym]) ImmutableArray[BaseSym] {
    return ImmutableArray[BaseSym].CastUp(items)
}
`
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)

        let unrelatedSource = `
package P
import System.Collections.Immutable

class ShapeA { }
class ShapeB { }

func BadUpcast(items ImmutableArray[ShapeB]) ImmutableArray[ShapeA] {
    return ImmutableArray[ShapeA].CastUp(items)
}
`
        let unrelatedDiagnostics = GetDiagnostics(unrelatedSource)
        Assert.Contains(
            unrelatedDiagnostics,
            (d Diagnostic) -> d.IsError && d.Message.Contains("CastUp", StringComparison.Ordinal)
        )
    }

    /// Issue #4625: a static explicit-interface clause targeting an imported CLR
    /// interface (`IS`) resolves without GS0494, while a clause naming a
    /// non-existent static member on that interface still reports GS0494.
    @Fact
    func Issue4625_StaticExplicitClauseOnImportedInterface_ResolvesValidSlotAndRejectsMissingSlot() {
        using let library = CSharpFixture(`namespace Clib;
public interface IS { static abstract int Z(); }
public interface ISlots {
    static abstract int P { get; }
    static abstract event System.Action Changed;
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let validSource = `
package P
import Clib

struct W : IS {
    shared {
        func (IS) Z() int32 {
            return 3
        }
    }
}
`
        let validCompilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(validSource)))
        Assert.Empty(validCompilation.GlobalScope.Diagnostics.AddRange(validCompilation.BoundProgram.Diagnostics))

        let invalidSource = `
package P
import Clib

struct W : IS {
    shared {
        func (IS) Z() int32 {
            return 3
        }
        func (IS) DoesNotExist() int32 {
            return 0
        }
    }
}
`
        let invalidCompilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(invalidSource)))
        let diagnostics = invalidCompilation
            .GlobalScope
            .Diagnostics
            .AddRange(invalidCompilation.BoundProgram.Diagnostics)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0494" && d.Message.Contains("DoesNotExist"))

        let duplicateOrdinaryEventSource = `
package P
import System
import Clib

struct W : ISlots {
    shared {
        prop (ISlots) P int32 { get { return 1 } }
        event (ISlots) Changed Action?
        event Changed Action?
        event Changed Action?
    }
}
`
        let dupCompilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(duplicateOrdinaryEventSource)))
        let dupDiagnostics = dupCompilation.GlobalScope.Diagnostics.AddRange(dupCompilation.BoundProgram.Diagnostics)
        let dupError = Assert.Single(dupDiagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal("GS0102", dupError.Id)

        let directExplicitAccessSource = `
package P
import System
import Clib

struct W : ISlots {
    shared {
        prop (ISlots) P int32 { get { return 1 } }
        event (ISlots) Changed Action?
    }
}

func Probe() int32 {
    W.Changed += () -> {}
    return W.P
}
`
        let accessCompilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(directExplicitAccessSource)))
        let accessDiagnostics = accessCompilation
            .GlobalScope
            .Diagnostics
            .AddRange(accessCompilation.BoundProgram.Diagnostics)
        Assert.Contains(
            accessDiagnostics,
            (d Diagnostic) -> d.Id == "GS0158" && d.Message.Contains("Changed", StringComparison.Ordinal)
        )
        Assert.Contains(
            accessDiagnostics,
            (d Diagnostic) -> d.Id == "GS0158" && d.Message.Contains("P", StringComparison.Ordinal)
        )

        let inheritedStaticNotHiddenByExplicitSource = `
package P
import System
import Clib

open class Base {
    shared {
        public prop P int32 { get { return 77 } }
        public event Changed Action?
    }
}

class Derived : Base, ISlots {
    shared {
        prop (ISlots) P int32 { get { return 1 } }
        event (ISlots) Changed Action?
    }
}

func ReadInherited() int32 {
    Derived.Changed += () -> {}
    return Derived.P
}
`
        let inheritedCompilation = Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(inheritedStaticNotHiddenByExplicitSource))
        )
        Assert.Empty(
            inheritedCompilation.GlobalScope.Diagnostics.AddRange(inheritedCompilation.BoundProgram.Diagnostics)
        )
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
