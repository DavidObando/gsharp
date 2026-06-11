// <copyright file="RecordAliasTests.cs" company="GSharp">
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
/// Phase 6.7 — <c>record</c> as a parse-time alias for <c>data struct</c>.
/// </summary>
public class RecordAliasTests
{
    [Fact]
    public void RecordAlias_ProducesDataStructSymbolShape()
    {
        var record = BuildStruct(@"
type Point record {
    var X int32
    var Y int32
}
0
");
        var dataStruct = BuildStruct(@"
type Point data struct {
    var X int32
    var Y int32
}
0
");

        Assert.Equal(dataStruct.Name, record.Name);
        Assert.Equal(dataStruct.IsData, record.IsData);
        Assert.False(record.IsClass);
        Assert.Equal(dataStruct.Fields.Select(f => f.Name), record.Fields.Select(f => f.Name));
        Assert.Equal(dataStruct.Fields.Select(f => f.Type.Name), record.Fields.Select(f => f.Type.Name));
    }

    [Fact]
    public void RecordAlias_EqualValues_AreEqual()
    {
        var result = Evaluate(@"
type Point record {
    var X int32
    var Y int32
}
Point{X: 1, Y: 2} == Point{X: 1, Y: 2}
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void RecordAlias_GenericDataStruct_Binds()
    {
        var result = Evaluate(@"
type Pair[A any, B any] record {
    var First A
    var Second B
}
let p = Pair[int32, string]{First: 1, Second: ""x""}
p.Second
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("x", result.Value);
    }

    [Fact]
    public void RecordAlias_ContextualKeywordFallback_AllowsVariableNamedRecord()
    {
        var result = Evaluate(@"
let record = 42
record
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void RecordAlias_ContextualKeywordFallback_AllowsFieldNamedRecord()
    {
        var result = Evaluate(@"
type X struct {
    var record int32
}
let x = X{record: 5}
x.record
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void RecordAlias_OpenRecord_Diagnoses()
    {
        var result = Evaluate(@"
type Foo open record {
    var Value int32
}
0
");

        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Unexpected token"));
    }

    [Fact]
    public void RecordAlias_DataRecord_Diagnoses()
    {
        var result = Evaluate(@"
type Foo data record {
    var Value int32
}
0
");

        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("cannot be combined with 'data'"));
    }

    [Fact]
    public void RecordAlias_SealedRecord_Diagnoses()
    {
        var result = Evaluate(@"
type Foo sealed record {
    var Value int32
}
0
");

        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Unexpected token"));
    }

    [Fact]
    public void RecordAlias_FunctionParameterTypeNameRecord_RemainsIdentifier()
    {
        var result = Evaluate(@"
func Use(r record) int32 {
    var return 0
}
0
");

        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Message == "Type 'record' doesn't exist.");
    }

    private static StructSymbol BuildStruct(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        return (StructSymbol)compilation.GlobalScope.Structs.Single(s => s.Name == "Point");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
