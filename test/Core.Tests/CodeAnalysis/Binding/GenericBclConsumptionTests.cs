// <copyright file="GenericBclConsumptionTests.cs" company="GSharp">
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
/// Phase 4.4 — generic BCL consumption. Users write
/// <c>List[int]</c> / <c>Dictionary[string, int]</c> in type position and the
/// binder constructs the closed CLR generic type via
/// <see cref="System.Type.MakeGenericType"/>.
/// </summary>
public class GenericBclConsumptionTests
{
    [Fact]
    public void ListIntInParameterType_Binds()
    {
        var source = @"
import System.Collections.Generic

func consume(xs List[int32]) int32 {
    return 0
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DictionaryStringIntInParameterType_Binds()
    {
        var source = @"
import System.Collections.Generic

func consume(d Dictionary[string, int32]) int32 {
    return 0
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void GenericTypeWrongArity_FallsThroughAndDiagnoses()
    {
        var source = @"
import System.Collections.Generic

func consume(xs List[int32, string]) int32 {
    return 0
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void TypeParameterAsTypeArgument_InParameterType_Binds()
    {
        // Issue #313: an in-scope generic type parameter used as a type
        // argument to a generic type (e.g. `List[T]`) must bind, including
        // element access in the body, instead of reporting `GS0149`.
        var source = @"
import System.Collections.Generic

func First[T](items List[T]) T {
    return items[0]
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TypeParameterAsTypeArgument_InReturnType_Binds()
    {
        // Issue #313: type parameter as a type argument in the return position.
        var source = @"
import System.Collections.Generic

func Echo[T](items List[T]) List[T] {
    return items
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TypeParameterAsTypeArgument_InLocalVariableType_Binds()
    {
        // Issue #313: type parameter as a type argument in a local declaration.
        var source = @"
import System.Collections.Generic

func PassThrough[T](items List[T]) List[T] {
    var local List[T] = items
    return local
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void TypeParameterAsTypeArgument_Nested_Binds()
    {
        // Issue #313: type parameter nested inside another generic type
        // argument (`List[Dictionary[string, T]]`).
        var source = @"
import System.Collections.Generic

func FirstValue[T](rows List[Dictionary[string, T]]) T {
    var head = rows[0]
    return head[""key""]
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
