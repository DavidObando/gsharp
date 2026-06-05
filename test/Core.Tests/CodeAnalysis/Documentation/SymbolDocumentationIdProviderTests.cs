// <copyright file="SymbolDocumentationIdProviderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Documentation;

/// <summary>
/// ADR-0057 §5: Tests that <see cref="SymbolDocumentationIdProvider"/> generates
/// correct DocIDs for G# source symbols.
/// </summary>
public class SymbolDocumentationIdProviderTests
{
    [Fact]
    public void Package_GeneratesNPrefix()
    {
        var package = new PackageSymbol("MyNamespace", null);
        var id = SymbolDocumentationIdProvider.GetDocumentationId(package);
        Assert.Equal("N:MyNamespace", id);
    }

    [Fact]
    public void SimpleFunction_GeneratesMPrefix()
    {
        var tree = SyntaxTree.Parse("package Lib\nfunc Greet() {}");
        var compilation = new Compilation(tree);
        var func = compilation.GlobalScope.Functions.First(f => f.Name == "Greet");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(func);
        Assert.Equal("M:Lib.Greet", id);
    }

    [Fact]
    public void FunctionWithParams_IncludesParameterTypes()
    {
        var tree = SyntaxTree.Parse("package Lib\nfunc Add(a int32, b int32) int32 { return a + b }");
        var compilation = new Compilation(tree);
        var func = compilation.GlobalScope.Functions.First(f => f.Name == "Add");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(func);
        Assert.Equal("M:Lib.Add(System.Int32,System.Int32)", id);
    }

    [Fact]
    public void StructType_GeneratesTPrefix()
    {
        var tree = SyntaxTree.Parse("package Lib\ntype Point data struct { X int32, Y int32 }");
        var compilation = new Compilation(tree);
        var type = compilation.GlobalScope.Structs.First(s => s.Name == "Point");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(type);
        Assert.Equal("T:Lib.Point", id);
    }

    [Fact]
    public void StructField_GeneratesFPrefix()
    {
        var tree = SyntaxTree.Parse("package Lib\ntype Point data struct { X int32, Y int32 }");
        var compilation = new Compilation(tree);
        var type = compilation.GlobalScope.Structs.First(s => s.Name == "Point");
        var field = type.Fields[0];
        var id = SymbolDocumentationIdProvider.GetDocumentationId(field, type);
        Assert.Equal("F:Lib.Point.X", id);
    }

    [Fact]
    public void FunctionWithRefParam_AppendsAtSign()
    {
        var tree = SyntaxTree.Parse("package Lib\nfunc Bump(ref x int32) {}");
        var compilation = new Compilation(tree);
        var func = compilation.GlobalScope.Functions.First(f => f.Name == "Bump");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(func);
        Assert.Equal("M:Lib.Bump(System.Int32@)", id);
    }

    [Fact]
    public void FunctionWithOutParam_AppendsAtSign()
    {
        var tree = SyntaxTree.Parse("package Lib\nfunc Produce(out r int32) {}");
        var compilation = new Compilation(tree);
        var func = compilation.GlobalScope.Functions.First(f => f.Name == "Produce");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(func);
        Assert.Equal("M:Lib.Produce(System.Int32@)", id);
    }

    [Fact]
    public void FunctionWithInParam_AppendsAtSign()
    {
        var tree = SyntaxTree.Parse("package Lib\nfunc Observe(in v int32) {}");
        var compilation = new Compilation(tree);
        var func = compilation.GlobalScope.Functions.First(f => f.Name == "Observe");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(func);
        Assert.Equal("M:Lib.Observe(System.Int32@)", id);
    }

    [Fact]
    public void FunctionWithMixedParams_OnlyRefKindGetsAtSign()
    {
        var tree = SyntaxTree.Parse("package Lib\nfunc Mix(a int32, ref b int32, c int32) {}");
        var compilation = new Compilation(tree);
        var func = compilation.GlobalScope.Functions.First(f => f.Name == "Mix");
        var id = SymbolDocumentationIdProvider.GetDocumentationId(func);
        Assert.Equal("M:Lib.Mix(System.Int32,System.Int32@,System.Int32)", id);
    }
}
