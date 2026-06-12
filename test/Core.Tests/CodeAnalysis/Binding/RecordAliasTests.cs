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
/// ADR-0078 / issue #718: the legacy <c>record</c> keyword and the
/// <c>type Name record { ... }</c> declaration head have been removed in
/// favor of the canonical <c>data class</c> / <c>data struct</c> forms.
/// These tests pin the migration shape and the new declaration semantics.
/// </summary>
public class RecordAliasTests
{
    [Fact]
    public void DataClass_ProducesClassSymbolShape()
    {
        var record = BuildStruct(@"
data class Point {
    var X int32
    var Y int32
}
0
");

        Assert.Equal("Point", record.Name);
        Assert.True(record.IsData);
        Assert.True(record.IsClass);
        Assert.Collection(
            record.Fields,
            f => Assert.Equal("X", f.Name),
            f => Assert.Equal("Y", f.Name));
    }

    [Fact]
    public void DataStruct_ProducesStructSymbolShape()
    {
        var dataStruct = BuildStruct(@"
data struct Point {
    var X int32
    var Y int32
}
0
");

        Assert.Equal("Point", dataStruct.Name);
        Assert.True(dataStruct.IsData);
        Assert.False(dataStruct.IsClass);
    }

    [Fact]
    public void DataStruct_EqualValues_AreEqual()
    {
        var result = Evaluate(@"
data struct Point {
    var X int32
    var Y int32
}
Point{X: 1, Y: 2} == Point{X: 1, Y: 2}
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataClass_GenericDataClass_Binds()
    {
        var result = Evaluate(@"
data class Pair[A any, B any] {
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
    public void RecordKeyword_AsTypeKind_IsRejected()
    {
        // ADR-0078 removes the `record` keyword. The legacy
        // `type Name record { ... }` head is reported with GS0307 (and the
        // generic GS0306 legacy-head migration diagnostic).
        var result = Evaluate(@"
type Foo record {
    var Value int32
}
0
");
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0307" || d.Id == "GS0306");
    }

    [Fact]
    public void RecordKeyword_AsIdentifier_StillBindsAsValueName()
    {
        var result = Evaluate(@"
let record = 42
record
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void RecordKeyword_AsFieldName_StillBindsAsIdentifier()
    {
        var result = Evaluate(@"
struct X {
    var record int32
}
let x = X{record: 5}
x.record
");

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void LegacyTypeHead_RejectedWithMigrationDiagnostic()
    {
        // ADR-0078: the entire `type Name <kind> ...` head is gone — the kind
        // keyword has to come first. The diagnostic should point at the new
        // grammar.
        var result = Evaluate(@"
type Foo class {
    var Value int32
}
0
");
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0306");
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
