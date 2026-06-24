// <copyright file="Issue1066InheritedInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1066: a class satisfies an interface member when the member is
/// implemented (or inherited) ANYWHERE in its base-class chain — not only when
/// declared directly on the class. Mirrors C# semantics where a base class's
/// accessible instance member satisfies an interface listed on a derived class.
/// The interface-satisfaction check must walk <c>BaseClass</c> for both methods
/// and properties (including the property's accessors).
/// </summary>
public class Issue1066InheritedInterfaceTests
{
    [Fact]
    public void LeafInheritsProperty_ViaTransitiveInterface_BindsWithNoDiagnostics()
    {
        // The canonical repro from the issue: IBase requires `prop H`, Base
        // implements it, and Leaf (→ Mid → Base) lists IDerived : IBase.
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            interface IDerived : IBase { }
            open class Base : IBase {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }
            open class Mid : Base { init(h int32) : base(h) { } }
            class Leaf : Mid, IDerived { init(h int32) : base(h) { } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DerivedClassListsInterface_PropertyImplementedOnImmediateBase_BindsClean()
    {
        // Requirement comes from a directly-listed interface implemented by a
        // base class.
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            open class Base {
                prop H int32 { get; init; }
                init(h int32) { H = h }
            }
            class Leaf : Base, IBase { init(h int32) : base(h) { } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void LeafInheritsMethod_ViaTransitiveInterface_BindsWithNoDiagnostics()
    {
        // Interface METHOD (not just a property) inherited from a base class.
        const string source = """
            package p
            interface IBase { func M() int32; }
            interface IDerived : IBase { }
            open class Base : IBase {
                func M() int32 { return 7 }
            }
            open class Mid : Base { }
            class Leaf : Mid, IDerived { }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenuinelyUnimplementedInterfaceMember_StillReportsGS0187()
    {
        // Negative guard: neither the class nor any base implements `prop H`.
        const string source = """
            package p
            interface IBase { prop H int32 { get; } }
            open class Base { }
            class Leaf : Base, IBase { }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0187");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
