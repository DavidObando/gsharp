// <copyright file="GenericMethodDelegateTests.cs" company="GSharp">
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
/// Issue #312 follow-up — a method (or free) type parameter used as a generic
/// argument of a delegate type, e.g. <c>func Map[U](f func(T) U) U</c>. The
/// binder must substitute type parameters that appear inside a
/// <see cref="FunctionTypeSymbol"/> (parameter and return positions) so the
/// delegate argument type-checks, and the substituted return type must flow to
/// the call site.
/// </summary>
public class GenericMethodDelegateTests
{
    [Fact]
    public void GenericMethod_DelegateParameterOverTypeParameters_Binds()
    {
        var source = @"
type Box[TItem] class {
    Value TItem
    func Map[TResult](f func(TItem) TResult) TResult {
        return f(this.Value)
    }
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericMethod_DelegateParameter_ValueTypeRoundTrips()
    {
        var source = @"
type Box[TItem] class {
    Value TItem
    func Map[TResult](f func(TItem) TResult) TResult {
        return f(this.Value)
    }
}
var b = Box[int32]{Value: 21}
b.Map[int32](func(x int32) int32 { return x + x })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericMethod_DelegateParameter_ReferenceTypeReturn()
    {
        var source = @"
type Box[TItem] class {
    Value TItem
    func Map[TResult](f func(TItem) TResult) TResult {
        return f(this.Value)
    }
}
var b = Box[int32]{Value: 21}
b.Map[string](func(x int32) string { return ""mapped"" })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("mapped", result.Value);
    }

    [Fact]
    public void GenericMethod_MultipleDelegateParameters_Bind()
    {
        var source = @"
type Box[TItem] class {
    Value TItem
    func Fold[TAcc](seed TAcc, f func(TAcc, TItem) TAcc) TAcc {
        return f(seed, this.Value)
    }
}
var b = Box[int32]{Value: 21}
b.Fold[int32](100, func(acc int32, x int32) int32 { return acc + x })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(121, result.Value);
    }

    [Fact]
    public void FreeGenericFunction_DelegateParameterOverTypeParameters_Binds()
    {
        var source = @"
func Apply[T, U](x T, f func(T) U) U {
    return f(x)
}
Apply[int32, bool](5, func(x int32) bool { return x > 3 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void FreeGenericFunction_DelegateReturnInferred_Substitutes()
    {
        var source = @"
func Apply[T, U](x T, f func(T) U) U {
    return f(x)
}
Apply(7, func(x int32) int32 { return x * 2 })
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(14, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
