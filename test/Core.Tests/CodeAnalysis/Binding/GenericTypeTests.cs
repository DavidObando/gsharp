// <copyright file="GenericTypeTests.cs" company="GSharp">
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
/// Phase 4.3a / ADR-0020 — generic data-struct/class declarations and
/// composite-literal instantiation. Constructed StructSymbols are cached so
/// reference equality holds for identical type-argument sequences.
/// </summary>
public class GenericTypeTests
{
    [Fact]
    public void GenericDataStruct_ExplicitTypeArgs_FieldAccessReturnsValue()
    {
        var source = @"
type Result[T any, E any] data struct {
    var Ok T
    var Err E
}
let r = Result[int32, string]{Ok: 5, Err: ""oops""}
r.Ok
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void GenericDataStruct_InferredTypeArgs_FieldAccessReturnsValue()
    {
        var source = @"
type Box[T any] data struct {
    var Value T
}
let b = Box{Value: 42}
b.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void GenericDataStruct_StructuralEquality_HoldsForEqualValues()
    {
        var source = @"
type Pair[A any, B any] data struct {
    var First A
    var Second B
}
let p1 = Pair[int32, string]{First: 1, Second: ""x""}
let p2 = Pair[int32, string]{First: 1, Second: ""x""}
p1 == p2
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void GenericDataStruct_WrongArity_Diagnoses()
    {
        var source = @"
type Result[T any, E any] data struct {
    var Ok T
    var Err E
}
let r = Result[int32]{Ok: 5, Err: ""oops""}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("type argument"));
    }

    [Fact]
    public void GenericClass_PrimaryCtorInferred_FieldAccessReturnsValue()
    {
        var source = @"
type Box[T any] class(Value T) {
}
let b = Box(7)
b.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void GenericClass_PrimaryCtorExplicit_FieldAccessReturnsValue()
    {
        var source = @"
type Box[T any] class(Value T) {
}
let b = Box[string](""hi"")
b.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void GenericClass_MethodCall_TypeChecksAndExecutes()
    {
        var source = @"
type Holder[T any] class(value T) {
    func Get() T { return value }
}
let h = Holder(42)
h.Get()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
