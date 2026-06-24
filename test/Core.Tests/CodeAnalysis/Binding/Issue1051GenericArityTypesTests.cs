// <copyright file="Issue1051GenericArityTypesTests.cs" company="GSharp">
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
/// Issue #1051: C#/CLR key types by (simple name, generic arity), so a type and
/// a same-named generic of a different arity — <c>Foo</c> and <c>Foo[T]</c>,
/// mirroring <c>Task</c>/<c>Task&lt;T&gt;</c> — coexist as distinct types. The
/// binder must not report GS0102 ("already declared") for that pair, must resolve
/// a reference to the type matching the supplied number of type arguments, and
/// must still report GS0102 for a genuine duplicate (same name AND same arity).
/// </summary>
public class Issue1051GenericArityTypesTests
{
    [Fact]
    public void ClassAndSameNamedGeneric_DifferentArity_BindsWithNoDiagnostics()
    {
        const string source = """
            package p
            open class Mp4Operation { }
            open class Mp4Operation[TOutput] : Mp4Operation { }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ClassAndSameNamedGeneric_BothSymbolsAreDeclared()
    {
        const string source = """
            package p
            open class Mp4Operation { }
            open class Mp4Operation[TOutput] : Mp4Operation { }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var byName = compilation.GlobalScope.Structs
            .Where(s => s.Name == "Mp4Operation")
            .ToList();
        Assert.Equal(2, byName.Count);
        Assert.Contains(byName, s => s.TypeParameters.Length == 0);
        Assert.Contains(byName, s => s.TypeParameters.Length == 1);

        // The generic's base type resolves to the arity-0 type.
        var generic = byName.Single(s => s.TypeParameters.Length == 1);
        var baseClass = generic.BaseClass;
        Assert.NotNull(baseClass);
        Assert.Equal("Mp4Operation", baseClass.Name);
        Assert.Empty(baseClass.TypeParameters);
    }

    [Fact]
    public void InterfaceAndSameNamedGeneric_DifferentArity_BindsWithNoDiagnostics()
    {
        const string source = """
            package p
            interface I { }
            interface I[T] { }
            class C : I { }
            class D[T] : I[T] { }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenuineDuplicateClass_SameArity0_ReportsGS0102()
    {
        const string source = """
            package p
            open class X { }
            open class X { }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void GenuineDuplicateGeneric_SameArity1_ReportsGS0102()
    {
        const string source = """
            package p
            class X[T] { }
            class X[T] { }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0102");
    }

    [Fact]
    public void ReferenceWithoutTypeArgs_ResolvesArity0_NoSpuriousNotGeneric()
    {
        const string source = """
            package p
            open class Box { }
            open class Box[T] : Box { }
            func F(b Box) { }
            """;
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0149");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ReferenceWithTypeArgs_ResolvesGenericArity_NoSpuriousNotGeneric()
    {
        const string source = """
            package p
            open class Box { }
            open class Box[T] : Box { var V T }
            func F(b Box[int32]) { }
            """;
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0149");
        Assert.Empty(diagnostics);
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
