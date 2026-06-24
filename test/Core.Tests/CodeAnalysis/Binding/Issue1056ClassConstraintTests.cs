// <copyright file="Issue1056ClassConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1056: a base CLASS (non-interface) may be used as a generic
/// type-parameter constraint, mirroring C#'s <c>where T : BaseClass</c>. The
/// constraint class's accessible instance members bind on values of <c>T</c>,
/// a type argument that does not derive from the constraint is rejected
/// (GS0152), and a value type used as a base constraint is still rejected
/// (GS0153). The single legacy constraint slot structurally enforces C#'s
/// at-most-one-class rule.
/// </summary>
public class Issue1056ClassConstraintTests
{
    [Fact]
    public void BaseClassConstraint_Binds_NoDiagnostics()
    {
        var source = @"
class Animal { func Speak() string { return ""..."" } }

func Describe[T Animal](x T) string { return ""ok"" }
Describe(Animal{})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void BaseClassConstraint_MemberDispatchOnT_BindsAndDispatchesOverride()
    {
        // An instance member declared on the constraint class binds on values of
        // T, and virtual dispatch resolves the most-derived override.
        var source = @"
open class Animal { open func Speak() string { return ""..."" } }
open class Dog : Animal { override func Speak() string { return ""woof"" } }

func Describe[T Animal](x T) string { return x.Speak() }
Describe[Dog](Dog())
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("woof", result.Value);
    }

    [Fact]
    public void NonDerivingTypeArgument_ReportsGS0152()
    {
        var source = @"
open class Animal { open func Speak() string { return ""..."" } }

func Describe[T Animal](x T) string { return ""ok"" }
Describe[int32](0)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void ValueTypeConstraint_StillReportsGS0153()
    {
        // C# forbids `where T : SomeStruct`; a value type is not a legal base
        // constraint even after issue #1056 permits class constraints.
        var source = @"
struct Val { var X int32 }

func F[T Val](x T) int32 { return 0 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0153");
    }

    [Fact]
    public void SelfReferentialBaseClassConstraint_Binds()
    {
        // CRTP `class Box[T Box]` / `class Box[T Box[T]]`: the declaring class
        // names itself in its own type-parameter constraint.
        var source = @"
open class Box[T Box] {}
open class Box2[T Box2[T]] {}
";
        var result = Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0153");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0113");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
