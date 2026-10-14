// <copyright file="Issue2830CollectionLiteralElementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #2830: `ParseCollectionElement` treated <i>every</i> leading
/// `[` inside a collection initializer as the start of an indexed entry
/// (`["key"] = value`), so an array literal used as an <i>element</i>
/// (`List[[]object]{ []object{1} }`) failed with GS0005. The parser now
/// looks ahead past the balanced bracket group and only takes the indexed-entry
/// path when an `=` follows. These tests pin both shapes.
open class Issue2830CollectionLiteralElementParserTests {
    @Theory
    @InlineData("List[[]object]{ []object{1} }")
    @InlineData("List[[]object]{ []object{1}, []object{2, 3} }")
    @InlineData("List[[]int32]{ [2]int32{1, 2} }")
    @InlineData("List[[][]int32]{ [][]int32{ []int32{1} } }")
    @InlineData("List[int32]{ 1, 2, 3 }")
    func ArrayLiteral_AsCollectionElement_Parses(initializer string) {
        AssertParses(initializer)
    }

    @Theory
    @InlineData("Dictionary[string,int32]{ [\"a\"] = 1 }")
    @InlineData("Dictionary[string,int32]{ [\"a\"] = 1, [\"b\"] = 2 }")
    @InlineData("map[string,int32]{ \"a\": 1 }")
    func IndexedEntry_AndMapLiteral_StillParse(initializer string) {
        AssertParses(initializer)
    }

    @Fact
    func ArrayLiteralElement_ProducesCollectionInitializerWithArrayCreationElement() {
        let collection = ParseCollectionInitializer("List[[]object]{ []object{1}, []object{2} }")
        Assert.Equal(2, collection.Elements.Count)
        Assert.All(
            collection.Elements,
            (element CollectionElementSyntax) -> Assert.IsType[ArrayCreationExpressionSyntax](
                Assert.IsType[ExpressionCollectionElementSyntax](element).Expression
            )
        )
    }

    @Fact
    func IndexedEntry_ProducesIndexedCollectionElement() {
        let collection = ParseCollectionInitializer("Dictionary[string,int32]{ [\"a\"] = 1 }")
        let element = Assert.Single(collection.Elements)
        Assert.IsType[IndexedCollectionElementSyntax](element)
    }

    shared {
        private func AssertParses(initializer string) {
            let tree = SyntaxTree.Parse((`
package P
func Use() {
    let value = ` + "$initializer" + `
}
`))
            Assert.Empty(tree.Diagnostics)
        }

        private func ParseCollectionInitializer(initializer string) CollectionInitializerExpressionSyntax {
            let tree = SyntaxTree.Parse((`
package P
func Use() {
    let value = ` + "$initializer" + `
}
`))
            Assert.Empty(tree.Diagnostics)
            let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
            let decl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
            return Assert.IsType[CollectionInitializerExpressionSyntax](decl.Initializer)
        }
    }
}
