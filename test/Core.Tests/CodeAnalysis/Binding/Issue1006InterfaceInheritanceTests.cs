// <copyright file="Issue1006InterfaceInheritanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1006: a G# <c>interface</c> may extend other interfaces via a
/// <c>: A, B</c> base clause (mirroring C# <c>interface B : A</c>). The binder
/// records the base interfaces on the <see cref="InterfaceSymbol"/>, surfaces
/// their members through the extending interface, expands an implementer's
/// interface set to the transitive closure, and rejects a class/struct base
/// with GS0391.
/// </summary>
public class Issue1006InterfaceInheritanceTests
{
    [Fact]
    public void InterfaceExtendsInterface_BindsWithNoDiagnostics()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface B : A { func G() int32; }
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InterfaceExtendsInterface_RecordsBaseInterfaceOnSymbol()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface B : A { func G() int32; }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var b = compilation.GlobalScope.Interfaces.Single(i => i.Name == "B");
        Assert.Contains(b.BaseInterfaces, i => i.Name == "A");

        // The extending interface surfaces its own and the inherited members.
        var memberNames = b.SelfAndAllBaseInterfaces()
            .SelectMany(i => i.Methods)
            .Select(m => m.Name)
            .ToList();
        Assert.Contains("F", memberNames);
        Assert.Contains("G", memberNames);
    }

    [Fact]
    public void ClassImplementingDerivedInterface_SatisfiesInheritedAndOwnMembers()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface B : A { func G() int32; }
            class C : B {
                func F() int32 { return 10 }
                func G() int32 { return 32 }
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        // Issue #1006: the implementer's interface set is expanded to the
        // transitive closure, so both B and the inherited A appear.
        var c = compilation.GlobalScope.Structs.Single(s => s.Name == "C");
        Assert.Contains(c.Interfaces, i => i.Name == "B");
        Assert.Contains(c.Interfaces, i => i.Name == "A");
    }

    [Fact]
    public void ClassImplementingDerivedInterface_MissingInheritedMember_ReportsGS0187()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface B : A { func G() int32; }
            class C : B {
                func G() int32 { return 32 }
            }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0187");
    }

    [Fact]
    public void InterfaceWithMultipleBases_BindsWithNoDiagnostics()
    {
        const string source = """
            package t
            interface A { func F() int32; }
            interface C { func H() int32; }
            interface B : A, C { func G() int32; }
            class Impl : B {
                func F() int32 { return 1 }
                func G() int32 { return 2 }
                func H() int32 { return 3 }
            }
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InterfaceNamingClassAsBase_ReportsGS0391()
    {
        const string source = """
            package t
            open class Base { func H() int32 { return 1 } }
            interface Bad : Base { func F() int32; }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0391");
    }

    [Fact]
    public void InterfaceNamingStructAsBase_ReportsGS0391()
    {
        const string source = """
            package t
            struct S { var X int32 }
            interface Bad : S { func F() int32; }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0391");
    }

    [Fact]
    public void InterfaceCallThroughBaseTypedReference_ResolvesInheritedMember()
    {
        // Calling an inherited member (F, declared on A) through a B-typed
        // reference must bind cleanly — member lookup walks the base chain.
        const string source = """
            package t
            import System
            interface A { func F() int32; }
            interface B : A { func G() int32; }
            class C : B {
                func F() int32 { return 10 }
                func G() int32 { return 32 }
            }
            var b B = C{}
            Console.WriteLine(b.F() + b.G())
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
