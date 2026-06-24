// <copyright file="Issue1061InterfaceCrtpConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1061: a self-referential / CRTP constraint on an INTERFACE
/// declaration — where the interface's own type parameter is constrained by the
/// interface being declared — must bind the same way it does on a class or
/// struct (issue #1056). The declaring interface's name and arity are now in
/// scope while its type-parameter constraints are bound, so
/// <c>interface IData[T IData]</c> and <c>interface IData[TData IData[TData]]</c>
/// resolve the interface instead of failing with GS0113. A value type used as a
/// constraint is still GS0153 and a genuinely-unknown constraint name is still
/// GS0113 (the blanket GS0113 suppression is NOT introduced).
/// </summary>
public class Issue1061InterfaceCrtpConstraintTests
{
    [Fact]
    public void SelfReferentialInterfaceConstraint_BareName_BindsWithoutDiagnostics()
    {
        const string source = """
            package p
            interface IData[T IData] {
                func Write(d int32);
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var iface = compilation.GlobalScope.Interfaces.Single(i => i.Name == "IData");
        var tp = Assert.Single(iface.TypeParameters);
        Assert.NotNull(tp.InterfaceConstraint);
        Assert.Same(iface, tp.InterfaceConstraint);
    }

    [Fact]
    public void SelfReferentialInterfaceConstraint_Crtp_BindsWithoutDiagnostics()
    {
        const string source = """
            package p
            interface IData[TData IData[TData]] {
                func Write(d int32);
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var iface = compilation.GlobalScope.Interfaces.Single(i => i.Name == "IData");
        var tp = Assert.Single(iface.TypeParameters);
        Assert.NotNull(tp.InterfaceConstraint);
        Assert.Same(iface, tp.InterfaceConstraint.Definition ?? tp.InterfaceConstraint);
    }

    [Fact]
    public void ValueTypeConstraintOnInterface_StillReportsGS0153()
    {
        // A value type is not a legal constraint even after #1061; the GS0113
        // suppression is specific to the declaring interface's own name.
        const string source = """
            package p
            interface IBad[T int32] {
                func Write(d int32);
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Contains(compilation.GlobalScope.Diagnostics, d => d.Id == "GS0153");
    }

    [Fact]
    public void UnknownConstraintTypeNameOnInterface_StillReportsGS0113()
    {
        // A genuinely-unknown constraint type name still fails with GS0113; the
        // fix did not blanket-suppress the "type doesn't exist" diagnostic.
        const string source = """
            package p
            interface IBad[T DoesNotExist] {
                func Write(d int32);
            }
            """;
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        Assert.Contains(compilation.GlobalScope.Diagnostics, d => d.Id == "GS0113");
    }
}
