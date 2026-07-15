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
    public void IndexerExplicitInterfaceClause_ParsesAndBinds_ButInterfacesCannotDeclareIndexersYet()
    {
        // ADR-0118/#944: G# interfaces cannot declare indexer members at all
        // (a pre-existing, unrelated scope boundary — DeclarationBinder
        // rejects any `prop this[...]` inside an `interface` block outright,
        // regardless of accessor bodies). That means an explicit-interface
        // qualifier clause on a CLASS indexer (`prop (X) this[...] T`) can
        // never find a matching interface member today. This test confirms
        // the ADR-0149 grammar/parser/binder plumbing for indexers is
        // forward-compatible and fails cleanly with GS0494 ("no matching
        // member") — not a parser error, crash, or wrong diagnostic — should
        // interface indexers ever be supported later.
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

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
