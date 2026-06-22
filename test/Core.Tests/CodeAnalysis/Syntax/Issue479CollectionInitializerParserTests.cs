// <copyright file="Issue479CollectionInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #479: parser regression coverage for collection initializers
/// (ADR-0117). A collection construction target followed by a
/// brace-enclosed element list parses to a
/// <see cref="CollectionInitializerExpressionSyntax"/> whose elements are
/// bare (<see cref="ExpressionCollectionElementSyntax"/>), keyed
/// (<see cref="KeyedCollectionElementSyntax"/>), or indexed
/// (<see cref="IndexedCollectionElementSyntax"/>). These tests pin the
/// grammar and the disambiguation from generic struct/class composite
/// literals and object initializers.
/// </summary>
public class Issue479CollectionInitializerParserTests
{
    private static CollectionInitializerExpressionSyntax ParseInitializer(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        return Assert.IsType<CollectionInitializerExpressionSyntax>(varDecl.Initializer);
    }

    [Fact]
    public void ListInitializer_NoParens_ParsesBareElements()
    {
        var init = ParseInitializer(@"
import System.Collections.Generic
let xs = List[int32]{ 1, 2, 3 }
");
        Assert.Equal(3, init.Elements.Count);
        Assert.All(init.Elements, e => Assert.IsType<ExpressionCollectionElementSyntax>(e));

        // The target is a (synthesized) zero-arg generic ctor call.
        var call = Assert.IsType<CallExpressionSyntax>(init.Target);
        Assert.Equal("List", call.Identifier.Text);
        Assert.NotNull(call.TypeArgumentList);
        Assert.Single(call.TypeArgumentList!.Arguments);
        Assert.Empty(call.Arguments);
    }

    [Fact]
    public void SetInitializer_EmptyParens_ParsesBareElements()
    {
        var init = ParseInitializer(@"
import System.Collections.Generic
let hs = HashSet[int32](){ 1, 2, 3 }
");
        Assert.Equal(3, init.Elements.Count);
        Assert.All(init.Elements, e => Assert.IsType<ExpressionCollectionElementSyntax>(e));

        var call = Assert.IsType<CallExpressionSyntax>(init.Target);
        Assert.Equal("HashSet", call.Identifier.Text);
        Assert.Empty(call.Arguments);
    }

    [Fact]
    public void DictionaryInitializer_KeyedPairs_ParsesKeyedElements()
    {
        var init = ParseInitializer(@"
import System.Collections.Generic
let d = Dictionary[string, int32]{ ""a"": 1, ""b"": 2 }
");
        Assert.Equal(2, init.Elements.Count);
        var first = Assert.IsType<KeyedCollectionElementSyntax>(init.Elements[0]);
        Assert.NotNull(first.Key);
        Assert.NotNull(first.Value);

        var call = Assert.IsType<CallExpressionSyntax>(init.Target);
        Assert.Equal("Dictionary", call.Identifier.Text);
        Assert.Equal(2, call.TypeArgumentList!.Arguments.Count);
    }

    [Fact]
    public void DictionaryInitializer_IndexedEntries_ParsesIndexedElements()
    {
        var init = ParseInitializer(@"
import System.Collections.Generic
let d = Dictionary[string, int32]{ [""x""] = 7, [""y""] = 8 }
");
        Assert.Equal(2, init.Elements.Count);
        var first = Assert.IsType<IndexedCollectionElementSyntax>(init.Elements[0]);
        Assert.NotNull(first.Key);
        Assert.NotNull(first.Value);
    }

    [Fact]
    public void DictionaryInitializer_WithConstructorArgs_ParsesArgsAndElements()
    {
        var init = ParseInitializer(@"
import System
import System.Collections.Generic
let d = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ ""Key"": 5 }
");
        var call = Assert.IsType<CallExpressionSyntax>(init.Target);
        Assert.Equal("Dictionary", call.Identifier.Text);
        Assert.Single(call.Arguments);
        Assert.Single(init.Elements);
        Assert.IsType<KeyedCollectionElementSyntax>(init.Elements[0]);
    }

    [Fact]
    public void ListInitializer_TrailingComma_IsAccepted()
    {
        var init = ParseInitializer(@"
import System.Collections.Generic
let xs = List[int32]{ 1, 2, 3, }
");
        Assert.Equal(3, init.Elements.Count);
    }

    [Fact]
    public void NestedListInitializers_Parse()
    {
        var init = ParseInitializer(@"
import System.Collections.Generic
let m = List[List[int32]]{ List[int32]{ 1, 2 }, List[int32]{ 3 } }
");
        Assert.Equal(2, init.Elements.Count);
        var firstElement = Assert.IsType<ExpressionCollectionElementSyntax>(init.Elements[0]);
        Assert.IsType<CollectionInitializerExpressionSyntax>(firstElement.Expression);
    }

    [Fact]
    public void GenericStructLiteral_WithIdentifierKeyedField_StaysStructLiteral()
    {
        // Disambiguation guard: an Identifier-keyed first entry means a
        // generic struct/class composite literal (field list), NOT a
        // collection initializer.
        var tree = SyntaxTree.Parse(@"
let r = Result[int32, string]{ Ok: 5 }
");
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        Assert.IsNotType<CollectionInitializerExpressionSyntax>(varDecl.Initializer);
    }

    [Fact]
    public void EmptyBraces_StayStructLiteral_NotCollectionInitializer()
    {
        // An empty brace after a generic type is the zero-field struct
        // literal, not an (empty) collection initializer.
        var tree = SyntaxTree.Parse(@"
let r = Result[int32, string]{ }
");
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        Assert.IsNotType<CollectionInitializerExpressionSyntax>(varDecl.Initializer);
    }
}
