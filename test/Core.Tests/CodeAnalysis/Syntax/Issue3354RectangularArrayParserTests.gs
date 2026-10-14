// <copyright file="Issue3354RectangularArrayParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser coverage for native rectangular arrays (issue #3354).
open class Issue3354RectangularArrayParserTests {
    @Fact
    func TypeClauses_PreserveRankNullableArrayAndGenericCommas() {
        let tree = SyntaxTree.Parse(`package P
func F(value [,]?int32, cube [,,]string, pair Pair[[,]int32, string]) [,]bool { return [1, 1]bool }
`)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Single(function.Parameters[0].Type!!.ArrayCommaTokens)
        Assert.NotNull(function.Parameters[0].Type!!.ArrayQuestionToken)
        Assert.Equal(2, function.Parameters[1].Type!!.ArrayCommaTokens.Length)
        Assert.Equal(2, function.Parameters[2].Type!!.TypeArguments?.Count)
        Assert.Single((function.Parameters[2].Type!!.TypeArguments?[0]?.ArrayCommaTokens)!!)
        Assert.Single(function.Type!!.ArrayCommaTokens)
    }

    @Fact
    func AllocationIndexAndInitializer_PreserveEverySeparatedExpression() {
        let tree = SyntaxTree.Parse(`package P
let a = [rows, cols]int32
let b = a[row, col]
let c = [2, 2]int32{1, 2, 3, 4}
`)
        Assert.Empty(tree.Diagnostics)
        let declarations = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .ToArray()
        let allocation = Assert.IsType[ArrayCreationExpressionSyntax](declarations[0].Initializer)
        let index = Assert.IsType[IndexExpressionSyntax](declarations[1].Initializer)
        let initializer = Assert.IsType[ArrayCreationExpressionSyntax](declarations[2].Initializer)
        Assert.Equal(2, allocation.Rank)
        Assert.Equal(2, allocation.Dimensions?.Count)
        Assert.Equal(2, index.Indices.Count)
        Assert.Equal(2, initializer.Rank)
        Assert.Equal(4, initializer.Elements?.Count)
        Assert.Equal(
            1,
            allocation.GetChildren().Count(
                (child SyntaxNode) -> object.ReferenceEquals(child, allocation.Dimensions?[0])
            )
        )
        Assert.Equal(
            1,
            index.GetChildren().Count((child SyntaxNode) -> object.ReferenceEquals(child, index.Indices[0]))
        )
    }

    @Fact
    func JaggedAndSzArrayForms_RemainDistinctFromRectangularArrays() {
        let tree = SyntaxTree.Parse(`package P
let jagged = [2][]int32
let slice = [2]int32
let rectangular = [2, 3]int32
`)
        Assert.Empty(tree.Diagnostics)
        let creations = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Select(
            (declaration VariableDeclarationSyntax) -> Assert.IsType[ArrayCreationExpressionSyntax](
                declaration.Initializer
            )
        )
            .ToArray()
        Assert.True(creations[0].HasNestedElementTypeClause)
        Assert.Equal(1, creations[0].Rank)
        Assert.Equal(1, creations[1].Rank)
        Assert.Equal(2, creations[2].Rank)
    }

    @Fact
    func MalformedDimensionAndIndexLists_RecoverAtFollowingDeclarations() {
        let tree = SyntaxTree.Parse(`package P
let bad = [2,, 3]int32
let good = [1, 1]int32
let item = good[0,, 0]
let tail = 42
`)
        Assert.NotEmpty(tree.Diagnostics)
        let declarations = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .ToArray()
        Assert.Equal(4, declarations.Length)
        Assert.Equal("tail", declarations[^1].Identifier.Text)
    }
}
