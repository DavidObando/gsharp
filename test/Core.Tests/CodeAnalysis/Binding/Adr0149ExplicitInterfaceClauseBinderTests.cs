// <copyright file="Adr0149ExplicitInterfaceClauseBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0149: binder-level diagnostics for the explicit-interface qualifier
/// clause (<c>func (X) M(...)</c> / <c>prop (X) P T</c> / <c>prop (X)
/// this[...] T</c>), plus the coexistence and indexer behaviors the clause
/// enables. See <c>Issue2010ExplicitInterfaceImplEmitTests</c>,
/// <c>Issue2181GenericExplicitInterfaceImplEmitTests</c>, and
/// <c>Issue2362ExplicitInterfacePropertyEmitTests</c> for the emit-level
/// (MethodImpl / metadata-name / runtime-dispatch) coverage of the same
/// clause; these tests focus on <see cref="GSharp.Core.CodeAnalysis.Binding.DeclarationBinder.ResolveExplicitInterfaceClauses"/>
/// and <c>VerifyExplicitInterfaceClauseResolution</c>'s own diagnostics.
/// </summary>
public class Adr0149ExplicitInterfaceClauseBinderTests
{
    [Fact]
    public void ClauseReferencesNonInterfaceType_ReportsGS0492()
    {
        var source = @"
package P

class NotAnInterface { }

class Host {
    private func (NotAnInterface) M() int32 { return 1 }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0492");
    }

    [Fact]
    public void PropertyClauseReferencesNonInterfaceType_ReportsGS0492()
    {
        var source = @"
package P

class NotAnInterface { }

class Host {
    private prop (NotAnInterface) P int32 -> 1
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0492");
    }

    [Fact]
    public void ClauseReferencesUnimplementedInterface_ReportsGS0493()
    {
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0493");
    }

    [Fact]
    public void ClauseReferencesInterfaceWithNoMatchingMember_ReportsGS0494()
    {
        var source = @"
package P

interface IFoo {
    prop Bar string { get; }
}

class Impl : IFoo {
    prop Bar string -> ""impl""

    private prop (IFoo) Baz string -> ""x""
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0494");
    }

    [Fact]
    public void TwoMembersClaimSameInterfaceSlot_ReportsGS0495()
    {
        var source = @"
package P

interface IFoo {
    func Bar() int32;
}

class Impl : IFoo {
    private func (IFoo) Bar() int32 { return 1 }

    private func (IFoo) Bar() int32 { return 2 }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0495");
    }

    [Fact]
    public void TwoPropertiesClaimSameInterfaceSlot_ReportsGS0495()
    {
        var source = @"
package P

interface IFoo {
    prop Bar string { get; }
}

class Impl : IFoo {
    private prop (IFoo) Bar string -> ""a""

    private prop (IFoo) Bar string -> ""b""
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0495");
    }

    [Fact]
    public void PublicPropertyAndExplicitClauseProperty_ShareSourceName_NoDiagnostics()
    {
        // The exact Oahu Authorization/IProfile shape: a plain, implicitly
        // dispatched property and a purely-explicit-slot property may share
        // the same declared source name — this is the entire point of the
        // clause (ADR-0149) and must not be flagged as a duplicate member.
        var source = @"
package P

interface IProfile {
    prop Authorization string { get; }
}

class Profile : IProfile {
    prop Authorization string { get; set; }

    private prop (IProfile) Authorization string -> Authorization
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TwoExplicitClausesTargetingDifferentInterfaces_ShareSourceName_NoDiagnostics()
    {
        var source = @"
package P

interface IFoo {
    func Bar() string;
}

interface IBaz {
    func Bar() string;
}

class Both : IFoo, IBaz {
    private func (IFoo) Bar() string { return ""foo"" }

    private func (IBaz) Bar() string { return ""baz"" }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IndexerExplicitInterfaceClause_TargetsInterfaceWithoutIndexer_ReportsGS0494()
    {
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
        var source = @"
package P

interface IEmpty {
    func Marker();
}

class Store : IEmpty {
    func Marker() { }

    prop this[index int32] string { get { return ""public"" } }

    private prop (IEmpty) this[index int32] string { get { return ""explicit"" } }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0494");
    }

    [Fact]
    public void IndexerExplicitInterfaceClause_TargetsInterfaceIndexer_NoDiagnostics()
    {
        // ADR-0149 (issue #944 follow-up): an interface CAN now declare its
        // own indexer contract, and a class's explicit-interface-clause
        // indexer resolves against it exactly like any other explicit member.
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TwoIndexersDifferentInterfaces_ShareParameterShape_NoDiagnostics()
    {
        // ADR-0149 (issue #944 follow-up): two explicit-interface indexer
        // implementations sharing the exact same parameter shape (both
        // `this[string]`) but targeting DIFFERENT interfaces must coexist —
        // exactly like the property/method coexistence case above — closing
        // the gap the old mangled-name convention only partially covered.
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void EventExplicitInterfaceClause_TargetsInterfaceWithNoMatchingMember_ReportsGS0494()
    {
        // ADR-0149: generalizes the method/property/indexer clause-resolution
        // sweep to events for the first time.
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0494");
    }

    [Fact]
    public void EventExplicitInterfaceClause_TargetsInterfaceEvent_NoDiagnostics()
    {
        var source = @"
package P

interface IFoo {
    event Changed () -> void
}

class Impl : IFoo {
    event (IFoo) Changed () -> void { add { } remove { } }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TwoEventsClaimSameInterfaceSlot_ReportsGS0495()
    {
        var source = @"
package P

interface IFoo {
    event Changed () -> void
}

class Impl : IFoo {
    event (IFoo) Changed () -> void { add { } remove { } }

    private event (IFoo) Changed () -> void { add { } remove { } }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0495");
    }

    [Fact]
    public void PublicEventAndExplicitClauseEvent_ShareSourceName_NoDiagnostics()
    {
        // Event-level counterpart of the Authorization/IProfile property
        // coexistence case above — a plain, implicitly dispatched event and a
        // purely-explicit-slot event may share the same declared source name.
        var source = @"
package P

interface IFoo {
    event Changed () -> void
}

class Impl : IFoo {
    event Changed () -> void { add { } remove { } }

    private event (IFoo) Changed () -> void { add { } remove { } }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TwoExplicitEventClausesTargetingDifferentInterfaces_ShareSourceName_NoDiagnostics()
    {
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void OrdinaryDuplicatePlainProperties_StillReportsSymbolAlreadyDeclared()
    {
        // Two ordinary (non-clause) same-name properties must still be
        // rejected as a duplicate — the ADR-0149 coexistence exemption must
        // not weaken this unrelated, pre-existing check.
        var source = @"
package P

class Host {
    prop Greeting string -> ""one""
    prop Greeting string -> ""two""
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0102");
    }

    // ADR-0149 follow-up (issue #2370, "final completion pass"): generalizes
    // the explicit-interface qualifier clause to STATIC methods/properties
    // (C# 11 `static abstract`/`static virtual` interface members,
    // ADR-0089/#755/#1019). See <c>Issue2370ExplicitInterfaceStaticMemberEmitTests</c>
    // for the emit-level (MethodImpl / runtime-dispatch) coverage; these
    // tests focus on the binder diagnostics, mirroring the instance-member
    // tests above exactly but inside a `shared { }` block.
    [Fact]
    public void StaticClauseReferencesNonInterfaceType_ReportsGS0492()
    {
        var source = @"
package P

class NotAnInterface { }

class Host {
    shared {
        private func (NotAnInterface) M() int32 { return 1 }
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0492");
    }

    [Fact]
    public void StaticClauseReferencesUnimplementedInterface_ReportsGS0493()
    {
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0493");
    }

    [Fact]
    public void StaticClauseReferencesInterfaceWithNoMatchingMember_ReportsGS0494()
    {
        var source = @"
package P

interface IFoo {
    shared {
        prop Bar string { get; }
    }
}

class Impl : IFoo {
    shared {
        prop Bar string -> ""impl""

        private prop (IFoo) Baz string -> ""x""
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0494");
    }

    [Fact]
    public void TwoStaticMethodsClaimSameInterfaceSlot_ReportsGS0495()
    {
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0495");
    }

    [Fact]
    public void TwoStaticPropertiesClaimSameInterfaceSlot_ReportsGS0495()
    {
        var source = @"
package P

interface IFoo {
    shared {
        prop Bar string { get; }
    }
}

class Impl : IFoo {
    shared {
        private prop (IFoo) Bar string -> ""a""

        private prop (IFoo) Bar string -> ""b""
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0495");
    }

    [Fact]
    public void StaticPublicMethodAndExplicitClauseMethod_ShareSourceName_NoDiagnostics()
    {
        // The static counterpart of the Oahu Authorization/IProfile shape: a
        // plain, implicitly-dispatched static method and a purely-explicit-
        // slot static method may share the same declared source name.
        var source = @"
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
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void TwoStaticExplicitClausesTargetingDifferentInterfaces_ShareSourceName_NoDiagnostics()
    {
        var source = @"
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
        private func (IFoo) Bar() string { return ""foo"" }

        private func (IBaz) Bar() string { return ""baz"" }
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Empty(diagnostics);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
