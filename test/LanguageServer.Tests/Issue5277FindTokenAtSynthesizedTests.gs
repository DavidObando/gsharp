// <copyright file="Issue5277FindTokenAtSynthesizedTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import Xunit

/// Issue #5277: a synthesized token has a zero-width span at the end of the token before it. The caret
/// at that end binds to the written token, not to the synthesized one.
open class Issue5277FindTokenAtSynthesizedTests {
    @Fact
    func CaretAfterExpressionBody_BindsToTheLastWrittenToken() {
        let source = "package p\nfunc F(x int32) int32 -> x\n"
        let tree = SyntaxTree.Parse(source)
        let token = SemanticLookup.FindTokenAt(tree, source.TrimEnd().Length)!!
        Assert.Equal("x", token.Text)
        Assert.Equal(SyntaxKind.IdentifierToken, token.Kind)
    }

    @Fact
    func CaretAfterBodylessType_BindsToTheLastWrittenToken() {
        let source = "package p\ndata class P(X int32)\n"
        let tree = SyntaxTree.Parse(source)
        let token = SemanticLookup.FindTokenAt(tree, source.TrimEnd().Length)!!
        Assert.Equal(")", token.Text)
    }
}
