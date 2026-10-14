// <copyright file="Issue2534BaseClassCallParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import Xunit

/// Issue #2534: parser coverage for canonical `base.M(...)` calls.
open class Issue2534BaseClassCallParserTests {
    @Fact
    func BaseCall_UsesDedicatedSyntax() {
        let tree = SyntaxTree.Parse("base.Describe()")
        Assert.Empty(tree.Diagnostics)
        let call BaseClassCallExpressionSyntax? = FindFirst[BaseClassCallExpressionSyntax](tree.Root)
        Assert.NotNull(call)
        Assert.Equal(SyntaxKind.BaseClassCallExpression, call!!.Kind)
        Assert.Equal("base", call!!.BaseKeyword.Text)
        Assert.Equal("Describe", call!!.Call.Identifier.Text)
    }

    @Fact
    func BaseCall_ResultChain_KeepsBaseCallAsReceiver() {
        let tree = SyntaxTree.Parse("base.Describe().ToUpperInvariant()")
        Assert.Empty(tree.Diagnostics)
        let outer AccessorExpressionSyntax? = FindFirst[AccessorExpressionSyntax](tree.Root)
        let call = Assert.IsType[BaseClassCallExpressionSyntax](outer!!.LeftPart)
        Assert.Equal("Describe", call.Call.Identifier.Text)
        Assert.Equal("ToUpperInvariant", Assert.IsType[CallExpressionSyntax](outer!!.RightPart).Identifier.Text)
    }

    shared {
        private func FindFirst[T SyntaxNode](root SyntaxNode) T? {
            if root is T match {
                return match
            }
            for child in root.GetChildren() {
                let found T? = FindFirst[T](child)
                if found != nil {
                    return found
                }
            }
            return nil
        }
    }
}
