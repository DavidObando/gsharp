// <copyright file="Issue3394PostfixContinuationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #3394: postfix increment/decrement results remain valid receivers for
/// member access, calls, and indexing.
open class Issue3394PostfixContinuationParserTests {
    @Fact
    func PostIncrementResult_CanBeMemberAccessReceiver() {
        const source = `package P
func F() {
    var count = 0
    let text = count++.ToString()
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[FunctionDeclarationSyntax]()
            .Single()
            .Body!!
            .Statements
            .OfType[VariableDeclarationSyntax]()
            .Last()
        Assert.IsType[AccessorExpressionSyntax](declaration.Initializer)
    }
}
