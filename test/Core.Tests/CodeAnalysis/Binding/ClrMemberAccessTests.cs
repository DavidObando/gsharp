// <copyright file="ClrMemberAccessTests.cs" company="GSharp">
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
/// Phase 4 exit (part 2) — member access on CLR instance values. Covers
/// instance property/field reads, indexer reads, and indexer writes
/// (including keyed writes on <c>Dictionary[K, V]</c>).
/// </summary>
public class ClrMemberAccessTests
{
    [Fact]
    public void ListCount_PropertyRead_Binds()
    {
        var source = @"
import System.Collections.Generic

var lst = List[int]()
lst.Add(1)
lst.Add(2)
var n = lst.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void StringBuilderLength_PropertyRead_Binds()
    {
        var source = @"
import System.Text

var sb = StringBuilder()
sb.Append(""abc"")
var n = sb.Length
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DictionaryIndexer_KeyedWriteAndRead_Bind()
    {
        var source = @"
import System.Collections.Generic

var d = Dictionary[string, int]()
d[""k""] = 42
var v = d[""k""]
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ListIndexer_ReadByIntKey_Binds()
    {
        var source = @"
import System.Collections.Generic

var lst = List[int]()
lst.Add(7)
var first = lst[0]
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void DictionaryIndexer_WrongKeyType_Diagnoses()
    {
        var source = @"
import System.Collections.Generic

var d = Dictionary[string, int]()
var v = d[5]
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void ClrMember_UnknownProperty_Diagnoses()
    {
        var source = @"
import System.Text

var sb = StringBuilder()
var x = sb.NotAReal
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
