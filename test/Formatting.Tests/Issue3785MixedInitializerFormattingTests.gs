// <copyright file="Issue3785MixedInitializerFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System.Linq
import Xunit

class Issue3785MixedInitializerFormattingTests {
    @Theory
    @InlineData("let x=Bag(){.Capacity:10,1,...rows,.Tag:2,}\n")
    @InlineData("let x=Bag[int32](4){...rows,key:2,\"c\":3,[key]=4,.Capacity:10,}\n")
    @InlineData("let x=Node(){.Name:\"root\",Node(){.Name:\"child\"},}\n")
    @InlineData("let x=Node{Width:1,Child(),...rows,Height:2,}\n")
    @InlineData("let x=Target{...source,Name:\"override\",}\n")
    func Formatting_PreservesEveryTokenAndIsIdempotent(source string) {
        let before = SyntaxTree.Parse(source)
        Assert.Empty(before.Diagnostics)
        let formatted = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(formatted.Diagnostics)
        let after = SyntaxTree.Parse(formatted.Text!!)
        Assert.Empty(after.Diagnostics)
        Assert.Equal(Tokens(before.Root), Tokens(after.Root))
        let twice = GSharpFormatter.Format(formatted.Text!!)
        Assert.Empty(twice.Diagnostics)
        Assert.False(twice.Changed)
        Assert.Equal(formatted.Text!!.ToString(), twice.Text!!.ToString())
    }

    shared {
        private func Tokens(node SyntaxNode)[]string -> if node is SyntaxToken token {
            []string{token.Kind.ToString() + ":" + token.Text}
        } else {
            node.GetChildren().SelectMany(Tokens).ToArray()
        }
    }
}
