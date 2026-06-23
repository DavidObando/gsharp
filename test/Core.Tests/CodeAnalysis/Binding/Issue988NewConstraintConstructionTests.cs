// <copyright file="Issue988NewConstraintConstructionTests.cs" company="GSharp">
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
/// Issue #988: binder-level coverage for constructing a type parameter under a
/// <c>new()</c> default-constructor constraint (<c>T()</c> where <c>[T new()]</c>).
/// The construction is reified to <c>Activator.CreateInstance&lt;T&gt;()</c> at
/// emit time (see <c>Issue988TypeParameterConstructionEmitTests</c>); these
/// tests lock in the binder contract: the construction binds clean when the
/// constraint is present, GS0389 fires when it is absent, and GS0152 fires when
/// a type argument cannot satisfy <c>new()</c>.
/// </summary>
public class Issue988NewConstraintConstructionTests
{
    [Fact]
    public void NewConstraint_ConstructTypeParameterInGenericClass_BindsWithoutDiagnostics()
    {
        var source = @"
class Factory[T new()] {
    func Make() T { return T() }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void NewConstraint_ConstructTypeParameterInGenericFunction_BindsWithoutDiagnostics()
    {
        var source = @"
func make[U new()]() U { return U() }
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void ConstructTypeParameterWithoutNewConstraint_ReportsGs0389()
    {
        var source = @"
class Factory[T class] {
    func Make() T { return T() }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0389");
    }

    [Fact]
    public void ConstructUnconstrainedTypeParameter_ReportsGs0389()
    {
        var source = @"
func make[U any]() U { return U() }
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0389");
    }

    [Fact]
    public void NewConstraint_TypeArgumentWithoutParameterlessCtor_ReportsGs0152()
    {
        var source = @"
class NoCtor(Value int32) { }
class Factory[T new()] {
    func Make() T { return T() }
}
let f = Factory[NoCtor]()
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void NewConstraint_ValueTypeArgument_SatisfiesConstraint()
    {
        var source = @"
class Factory[T new()] {
    func Make() T { return T() }
}
let f = Factory[int32]()
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0152");
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics.ToList();
    }
}
