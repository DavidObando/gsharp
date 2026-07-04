// <copyright file="Issue1932GenericMethodInferenceOverUserTypeTests.cs" company="GSharp">
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
/// Issue #1932: generic-method type-argument inference must unify a
/// parameter over a USER-DEFINED generic type (a G# <c>struct</c>/<c>class</c>
/// -&gt; <see cref="StructSymbol"/>, or <c>interface</c> -&gt;
/// <see cref="InterfaceSymbol"/>) against a constructed argument of that same
/// type, the same way it already does for imported CLR generics such as
/// <c>List[T]</c> (issue #313). Previously only the CLR-generic path was
/// handled in <c>Binder.InferTypeArguments</c>, so calling a generic function
/// with a user generic struct/class/interface argument required an explicit
/// type argument.
/// </summary>
public class Issue1932GenericMethodInferenceOverUserTypeTests
{
    [Fact]
    public void GenericStructArgument_InfersTypeArgument_NoExplicitTypeArgNeeded()
    {
        var source = @"
struct Pair[T] {
    var First T
    var Second T
}

func Swap[T](p Pair[T]) Pair[T] {
    return Pair[T]{First: p.Second, Second: p.First}
}

var pair = Pair[string]{First: ""a"", Second: ""b""}
var swapped = Swap(pair)
swapped.First + "","" + swapped.Second
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("b,a", result.Value);
    }

    [Fact]
    public void GenericClassArgument_InfersTypeArgument()
    {
        var source = @"
class Box[T] {
    var Value T
}

func Unwrap[T](b Box[T]) T {
    return b.Value
}

var box = Box[int32]{Value: 42}
Unwrap(box)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericInterfaceParameter_InfersTypeArgument_FromImplementingArgument()
    {
        // A user struct implementing a user generic interface must also
        // unify: parameter `IHolder[T]` against an argument whose static type
        // implements `IHolder[string]` (not `IHolder[T]` itself).
        var source = @"
interface IHolder[T] {
    func Get() T;
}

struct StringBox : IHolder[string] {
    var Value string
    func Get() string { return Value }
}

func Describe[T](h IHolder[T]) T {
    return h.Get()
}

Describe(StringBox{Value: ""hi""})
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void ExplicitTypeArgument_StillWorks_ControlCase()
    {
        var source = @"
struct Pair[T] {
    var First T
    var Second T
}

func Swap[T](p Pair[T]) Pair[T] {
    return Pair[T]{First: p.Second, Second: p.First}
}

var pair = Pair[string]{First: ""a"", Second: ""b""}
var swapped = Swap[string](pair)
swapped.First
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("b", result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
