// <copyright file="GenericMethodOnTypeTests.cs" company="GSharp">
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
/// Issue #312 — generic methods declared as members of a user-defined type.
/// A <c>func</c> with its own <c>[T]</c> type-parameter list inside a
/// <c>class</c>/<c>shared</c> body must introduce its type parameters into the
/// binding scope of the member so that parameter types, return types, locals,
/// and the body can reference <c>T</c>, and so call sites resolve via inference
/// or explicit type arguments.
/// </summary>
public class GenericMethodOnTypeTests
{
    [Fact]
    public void GenericInstanceMethod_DeclarationBinds_NoDiagnostics()
    {
        // The repro from the issue: the method's `T` used to fail with GS0113.
        var source = @"
class Box {
    func Wrap[T](item T) T { return item }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericInstanceMethod_InferredFromIntArgument_ReturnsInt()
    {
        var source = @"
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap(5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void GenericInstanceMethod_InferredFromStringArgument_ReturnsString()
    {
        var source = @"
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap(""hi"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void GenericInstanceMethod_ExplicitTypeArgument_ReturnsInt()
    {
        var source = @"
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap[int32](7)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void GenericInstanceMethod_TypeParameterUsableInLocal()
    {
        var source = @"
class Box {
    func Wrap[T](item T) T {
        var local T = item
        return local
    }
}
var b = Box{}
b.Wrap(11)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void GenericInstanceMethod_TwoTypeParameters_FirstWins()
    {
        var source = @"
class Box {
    func Pair[T, U](a T, b U) T { return a }
}
var b = Box{}
b.Pair(10, ""ignored"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void GenericInstanceMethod_WrongExplicitArity_Diagnoses()
    {
        var source = @"
class Box {
    func Wrap[T](item T) T { return item }
}
var b = Box{}
b.Wrap[int32, string](5)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericInstanceMethod_ComparableConstraint_NonComparableArg_Diagnoses()
    {
        var source = @"
class Box {
    func Eq[T comparable](a T, b T) bool { return a == b }
}
var b = Box{}
b.Eq[[]int32]([]int32{1}, []int32{1})
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void GenericStaticMethod_InferredFromArgument_ReturnsInt()
    {
        var source = @"
class Util {
    shared {
        func Identity[T](x T) T { return x }
    }
}
Util.Identity(3)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void GenericMethod_OnGenericClass_OwnTypeParameter_Binds()
    {
        var source = @"
class Container[T] {
    var Value T
    func GetOr[U](other U) U { return other }
}
var c = Container[int32]{Value: 1}
c.GetOr(""x"")
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("x", result.Value);
    }

    [Fact]
    public void GenericMethod_OnGenericClass_ClassTypeParameter_UsableInBody()
    {
        var source = @"
class Container[T] {
    var Value T
    func Echo(x T) T { return x }
}
var c = Container[int32]{Value: 1}
c.Echo(9)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
