// <copyright file="GenericInterfaceTests.cs" company="GSharp">
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
/// Phase 4.3c / ADR-0020 — generic <c>interface</c> declarations with optional
/// variance modifiers (ADR-0021). Verifies that generic interfaces parse,
/// bind, can be referenced as constructed types <c>Foo[int]</c> in type
/// position, and that variance position violations are reported.
/// </summary>
public class GenericInterfaceTests
{
    [Fact]
    public void GenericInterfaceDeclaration_Binds()
    {
        var source = @"
interface Iter[T any] {
    func Next() T;
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ConstructedInterface_AsParameterType_Binds()
    {
        var source = @"
interface Iter[T any] {
    func Next() T;
}

func consume(it Iter[int32]) int32 {
    return it.Next()
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void VarianceOut_OnReturn_OK()
    {
        var source = @"
interface Producer[out T] {
    func Get() T;
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void VarianceIn_OnParam_OK()
    {
        var source = @"
interface Consumer[in T] {
    func Put(v T);
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void VarianceOut_InParamPosition_Diagnoses()
    {
        var source = @"
interface Bad[out T] {
    func Take(v T);
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'out'") && d.Message.Contains("input"));
    }

    [Fact]
    public void VarianceIn_InReturnPosition_Diagnoses()
    {
        var source = @"
interface Bad[in T] {
    func Get() T;
}
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("'in'") && d.Message.Contains("output"));
    }

    [Fact]
    public void ConstructedInterface_WrongArity_Diagnoses()
    {
        var source = @"
interface Iter[T any] {
    func Next() T;
}

func consume(it Iter[int32, string]) int32 { return 0 }
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("requires") || d.Message.Contains("type argument"));
    }

    [Fact]
    public void SealedGenericInterface_Binds()
    {
        var source = @"
sealed interface Result[T any] {
    func Get() T;
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
