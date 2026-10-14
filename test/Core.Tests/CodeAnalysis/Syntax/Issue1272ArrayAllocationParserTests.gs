// <copyright file="Issue1272ArrayAllocationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1272: parser-level coverage for the native runtime/zero-initialised
/// array allocation form `[n]T` (and the equivalent empty-initializer
/// spelling `[n]T{}`), where `n` is an arbitrary length expression and
/// there are no element initialisers. The existing literal form
/// (`[N]T{…}`), slice form (`[]T{…}`), and jagged form
/// (`[][]int32{…}`) keep parsing unchanged.
open class Issue1272ArrayAllocationParserTests {
    @Fact
    func RuntimeLength_Identifier_NoInitializer() {
        let creation = GetArrayCreation("[n]int32")
        Assert.True(creation.IsRuntimeLengthAllocation)
        Assert.False(creation.HasInitializer)
        Assert.Null(creation.LengthToken)
        let name = Assert.IsType[NameExpressionSyntax](creation.LengthExpression)
        Assert.Equal("n", name.IdentifierToken.Text)
        Assert.Equal("int32", creation.ElementTypeIdentifier!!.Text)
    }

    @Fact
    func RuntimeLength_Expression_NoInitializer() {
        let creation = GetArrayCreation("[n + 1]int32")
        Assert.True(creation.IsRuntimeLengthAllocation)
        Assert.False(creation.HasInitializer)
        Assert.IsType[BinaryExpressionSyntax](creation.LengthExpression)
    }

    @Fact
    func RuntimeLength_EmptyInitializer_IsAllocationForm() {
        let creation = GetArrayCreation("[n]int32{}")
        Assert.True(creation.IsRuntimeLengthAllocation)
        Assert.True(creation.HasInitializer)
        Assert.Empty(creation.Elements!!)
    }

    @Fact
    func ConstantLength_NoInitializer_IsAllocationForm() {
        let creation = GetArrayCreation("[5]int32")
        Assert.True(creation.IsRuntimeLengthAllocation)
        Assert.False(creation.HasInitializer)
        let literal = Assert.IsType[LiteralExpressionSyntax](creation.LengthExpression)
        Assert.Equal(SyntaxKind.NumberToken, literal.LiteralToken.Kind)
    }

    @Fact
    func LiteralForm_WithInitializer_Unchanged() {
        let creation = GetArrayCreation("[5]int32{1, 2, 3, 4, 5}")
        Assert.False(creation.IsRuntimeLengthAllocation)
        Assert.Null(creation.LengthExpression)
        Assert.NotNull(creation.LengthToken)
        Assert.Equal("5", creation.LengthToken!!.Text)
        Assert.Equal(5, creation.Elements!!.Count)
    }

    @Fact
    func SliceForm_WithInitializer_Unchanged() {
        let creation = GetArrayCreation("[]int32{1, 2, 3}")
        Assert.False(creation.IsRuntimeLengthAllocation)
        Assert.Null(creation.LengthExpression)
        Assert.Null(creation.LengthToken)
        Assert.Equal(3, creation.Elements!!.Count)
    }

    @Fact
    func JaggedForm_WithInitializer_Unchanged() {
        let creation = GetArrayCreation("[][]int32{ []int32{1}, []int32{2, 3} }")
        Assert.False(creation.IsRuntimeLengthAllocation)
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.Equal(2, creation.Elements!!.Count)
    }

    @Fact
    func RuntimeLength_NestedElement_NoInitializer() {
        let creation = GetArrayCreation("[n][]int32")
        Assert.True(creation.IsRuntimeLengthAllocation)
        Assert.True(creation.HasNestedElementTypeClause)
        Assert.False(creation.HasInitializer)
    }

    shared {
        private func GetArrayCreation(initializer string) ArrayCreationExpressionSyntax {
            let tree = SyntaxTree.Parse((`package P
let x = ` + "$initializer" + `
`))
            Assert.Empty(tree.Diagnostics)
            let decl = tree
                .Root
                .Members
                .OfType[GlobalStatementSyntax]()
                .Select((g GlobalStatementSyntax) -> g.Statement)
                .OfType[VariableDeclarationSyntax]()
                .Single()
            return Assert.IsType[ArrayCreationExpressionSyntax](decl.Initializer)
        }
    }
}
