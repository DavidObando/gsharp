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

func consume(xs List[int]) int {
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

func consume(d Dictionary[string, int]) int {
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

func consume(xs List[int, string]) int {
    return 0
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
