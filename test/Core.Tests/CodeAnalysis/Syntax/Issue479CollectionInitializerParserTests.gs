// <copyright file="Issue479CollectionInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #479: parser regression coverage for collection initializers
/// (ADR-0117). A collection construction target followed by a
/// brace-enclosed element list parses to a
/// (cref:CollectionInitializerExpressionSyntax) whose elements are
/// bare ((cref:ExpressionCollectionElementSyntax)), keyed
/// ((cref:KeyedCollectionElementSyntax)), or indexed
/// ((cref:IndexedCollectionElementSyntax)). These tests pin the
/// grammar and the disambiguation from generic struct/class composite
/// literals and object initializers.
open class Issue479CollectionInitializerParserTests {
    @Fact
    func ListInitializer_NoParens_ParsesBareElements() {
        let init = ParseInitializer(`
import System.Collections.Generic
let xs = List[int32]{ 1, 2, 3 }
`)
        Assert.Equal(3, init.Elements.Count)
        Assert.All(init.Elements, (e CollectionElementSyntax) -> Assert.IsType[ExpressionCollectionElementSyntax](e))
        // The target is a (synthesized) zero-arg generic ctor call.
        let call = Assert.IsType[CallExpressionSyntax](init.Target)
        Assert.Equal("List", call.Identifier.Text)
        Assert.NotNull(call.TypeArgumentList)
        Assert.Single(call.TypeArgumentList!!.Arguments)
        Assert.Empty(call.Arguments)
    }

    @Fact
    func SetInitializer_EmptyParens_ParsesBareElements() {
        let init = ParseInitializer(`
import System.Collections.Generic
let hs = HashSet[int32](){ 1, 2, 3 }
`)
        Assert.Equal(3, init.Elements.Count)
        Assert.All(init.Elements, (e CollectionElementSyntax) -> Assert.IsType[ExpressionCollectionElementSyntax](e))
        let call = Assert.IsType[CallExpressionSyntax](init.Target)
        Assert.Equal("HashSet", call.Identifier.Text)
        Assert.Empty(call.Arguments)
    }

    @Fact
    func ConstructorInitializer_SingleIdentifier_ParsesBareElement() {
        let init = ParseInitializer(`
let bag = Bag(){ item }
`)
        Assert.Single(init.Elements)
        let element = Assert.IsType[ExpressionCollectionElementSyntax](init.Elements[0])
        Assert.IsType[NameExpressionSyntax](element.Expression)
    }

    @Fact
    func CallFollowedByBlockOnNextLine_StaysSeparate() {
        let tree = SyntaxTree.Parse(`
Reset()
{
    defer Record()
}
`)
        Assert.Empty(tree.Diagnostics)
        let statement = tree.Root.Members.OfType[GlobalStatementSyntax]().First().Statement
        let expression = Assert.IsType[ExpressionStatementSyntax](statement).Expression
        Assert.IsType[CallExpressionSyntax](expression)
    }

    @Fact
    func CallAndBraceFollowedByElementOnNextLine_StaysSeparate() {
        let tree = SyntaxTree.Parse(`
Reset() {
    Record
}
`)
        Assert.Empty(tree.Diagnostics)
        let statement = tree.Root.Members.OfType[GlobalStatementSyntax]().First().Statement
        let expression = Assert.IsType[ExpressionStatementSyntax](statement).Expression
        Assert.IsType[CallExpressionSyntax](expression)
    }

    @Fact
    func DictionaryInitializer_KeyedPairs_ParsesKeyedElements() {
        let init = ParseInitializer(`
import System.Collections.Generic
let d = Dictionary[string, int32]{ "a": 1, "b": 2 }
`)
        Assert.Equal(2, init.Elements.Count)
        let first = Assert.IsType[KeyedCollectionElementSyntax](init.Elements[0])
        Assert.NotNull(first.Key)
        Assert.NotNull(first.Value)
        let call = Assert.IsType[CallExpressionSyntax](init.Target)
        Assert.Equal("Dictionary", call.Identifier.Text)
        Assert.Equal(2, call.TypeArgumentList!!.Arguments.Count)
    }

    @Fact
    func DictionaryInitializer_IndexedEntries_ParsesIndexedElements() {
        let init = ParseInitializer(`
import System.Collections.Generic
let d = Dictionary[string, int32]{ ["x"] = 7, ["y"] = 8 }
`)
        Assert.Equal(2, init.Elements.Count)
        let first = Assert.IsType[IndexedCollectionElementSyntax](init.Elements[0])
        Assert.NotNull(first.Key)
        Assert.NotNull(first.Value)
    }

    @Fact
    func DictionaryInitializer_WithConstructorArgs_ParsesArgsAndElements() {
        let init = ParseInitializer(`
import System
import System.Collections.Generic
let d = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ "Key": 5 }
`)
        let call = Assert.IsType[CallExpressionSyntax](init.Target)
        Assert.Equal("Dictionary", call.Identifier.Text)
        Assert.Single(call.Arguments)
        Assert.Single(init.Elements)
        Assert.IsType[KeyedCollectionElementSyntax](init.Elements[0])
    }

    @Fact
    func ListInitializer_TrailingComma_IsAccepted() {
        let init = ParseInitializer(`
import System.Collections.Generic
let xs = List[int32]{ 1, 2, 3, }
`)
        Assert.Equal(3, init.Elements.Count)
    }

    @Fact
    func NestedListInitializers_Parse() {
        let init = ParseInitializer(`
import System.Collections.Generic
let m = List[List[int32]]{ List[int32]{ 1, 2 }, List[int32]{ 3 } }
`)
        Assert.Equal(2, init.Elements.Count)
        let firstElement = Assert.IsType[ExpressionCollectionElementSyntax](init.Elements[0])
        Assert.IsType[CollectionInitializerExpressionSyntax](firstElement.Expression)
    }

    @Fact
    func GenericStructLiteral_WithIdentifierKeyedField_StaysStructLiteral() {
        // Disambiguation guard: an Identifier-keyed first entry means a
        // generic struct/class composite literal (field list), NOT a
        // collection initializer.
        let tree = SyntaxTree.Parse(`
let r = Result[int32, string]{ Ok: 5 }
`)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        Assert.IsNotType[CollectionInitializerExpressionSyntax](varDecl.Initializer)
    }

    @Fact
    func EmptyBraces_StayStructLiteral_NotCollectionInitializer() {
        // An empty brace after a generic type is the zero-field struct
        // literal, not an (empty) collection initializer.
        let tree = SyntaxTree.Parse(`
let r = Result[int32, string]{ }
`)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        Assert.IsNotType[CollectionInitializerExpressionSyntax](varDecl.Initializer)
    }

    shared {
        private func ParseInitializer(source string) CollectionInitializerExpressionSyntax {
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let varDecl = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return Assert.IsType[CollectionInitializerExpressionSyntax](varDecl.Initializer)
        }
    }
}
