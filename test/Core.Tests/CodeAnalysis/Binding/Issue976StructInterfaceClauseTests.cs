// <copyright file="Issue976StructInterfaceClauseTests.cs" company="GSharp">
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
/// Issue #976: a G# <c>struct</c> (CLR value type) may declare an
/// implemented-interface clause (<c>struct S : I { … }</c>), mirroring a
/// <c>class</c>. The parser already accepts the base/interface clause for
/// structs; the binder accepts interfaces but rejects a class/struct base type
/// with GS0382, and enforces interface satisfaction via the same GS0187
/// channel classes use.
/// </summary>
public class Issue976StructInterfaceClauseTests
{
    [Fact]
    public void StructInterfaceClause_Parses_WithNoDiagnostics()
    {
        const string source = """
            package P
            import System
            struct Money : IEquatable[Money] {
                var Cents int32
                func Equals(other Money) bool { return Cents == other.Cents }
            }
            """;
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void StructInterfaceClause_Binds_WithNoDiagnostics()
    {
        const string source = """
            package P
            import System
            struct Money : IEquatable[Money] {
                var Cents int32
                func Equals(other Money) bool { return Cents == other.Cents }
            }
            """;
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void StructImplementsUserInterface_RecordsInterfaceOnSymbol()
    {
        const string source = """
            package P
            interface IShape {
                func Area() int32;
            }
            struct Square : IShape {
                var Side int32
                func Area() int32 { return Side * Side }
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var square = compilation.GlobalScope.Structs
            .Single(s => s.Name == "Square");
        Assert.False(square.IsClass, "Square must be a value-type struct");
        Assert.Contains(square.Interfaces, i => i.Name == "IShape");
    }

    [Fact]
    public void StructNamingClassAsBase_ReportsGS0382()
    {
        const string source = """
            package P
            class Base { var X int32 }
            struct S : Base { var Y int32 }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0382");
    }

    [Fact]
    public void StructNamingAnotherStructAsBase_ReportsGS0382()
    {
        const string source = """
            package P
            struct Other { var X int32 }
            struct S : Other { var Y int32 }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0382");
    }

    [Fact]
    public void StructMissingInterfaceMember_ReportsGS0187()
    {
        const string source = """
            package P
            import System
            struct Money : IComparable[Money] {
                var Cents int32
            }
            """;
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0187");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
