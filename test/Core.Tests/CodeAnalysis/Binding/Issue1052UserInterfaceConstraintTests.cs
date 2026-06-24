// <copyright file="Issue1052UserInterfaceConstraintTests.cs" company="GSharp">
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
/// Issue #1052: a USER-declared interface may be used as a generic
/// type-parameter constraint whether or not it is declared <c>sealed</c>,
/// matching imported CLR interfaces and C#'s <c>where T : IFoo</c>. The former
/// <c>sealed</c>-only gate (Phase 4.2b / ADR-0020) is removed; a constraint
/// that is not an interface is still rejected (GS0153), and a type argument
/// that does not implement the constraint is still rejected (GS0152).
/// </summary>
public class Issue1052UserInterfaceConstraintTests
{
    [Fact]
    public void NonSealedUserInterface_AsConstraint_Binds_NoDiagnostics()
    {
        var source = @"
interface IShape {
    func Area() float64;
}

struct Sq : IShape {
    var S float64
    func Area() float64 { return S * S }
}

func Describe[T IShape](x T) float64 { return x.Area() }
Describe(Sq{S: 3.0})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9.0, result.Value);
    }

    [Fact]
    public void NonSealedUserInterface_MemberDispatchOnT_Binds()
    {
        // Instance members of the constraint interface must bind on values of T.
        var source = @"
interface IGreeter {
    func Greet() string;
}

struct En : IGreeter {
    func Greet() string { return ""hi"" }
}

func Run[T IGreeter](x T) string { return x.Greet() }
Run(En{})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void NonImplementingTypeArgument_StillReportsGS0152()
    {
        var source = @"
interface IShape {
    func Area() float64;
}

struct NotAShape { var X int32 }

func Describe[T IShape](x T) float64 { return 0.0 }
Describe[NotAShape](NotAShape{X: 1})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0152");
    }

    [Fact]
    public void NonInterfaceConstraint_ReportsGS0153()
    {
        // Only interfaces are legal constraints; a class is rejected.
        var source = @"
class Base {}

func F[T Base](x T) int32 { return 0 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0153");
    }

    [Fact]
    public void SealedUserInterface_AsConstraint_StillBinds()
    {
        // Control: the previously-allowed sealed form is not regressed.
        var source = @"
sealed interface IShape {
    func Area() int32;
}

struct Sq : IShape {
    var S int32
    func Area() int32 { return S * S }
}

func Describe[T IShape](x T) int32 { return x.Area() }
Describe(Sq{S: 4})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(16, result.Value);
    }

    [Fact]
    public void SelfReferentialUserGenericInterface_AsConstraint_Binds()
    {
        // Issue #1052: the `[T IFace[T]]` shape over a user-declared generic
        // interface binds and validates constraint satisfaction by
        // self-substitution.
        var source = @"
interface ICmp[T] {
    func CompareTo(other T) int32;
}

struct Num : ICmp[Num] {
    var V int32
    func CompareTo(other Num) int32 { return V - other.V }
}

func Bigger[T ICmp[T]](a T, b T) int32 { return a.CompareTo(b) }
Bigger(Num{V: 7}, Num{V: 3})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
