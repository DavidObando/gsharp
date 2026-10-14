// <copyright file="Issue4219GenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System.Linq
import Xunit

open class Issue4219GenericLocalRecursionTests {
    @Fact
    func Formatting_PreservesConsecutiveGenericDeclarationRegion() {
        const source = `let first[T]=func(x T,n int32) T {return second[T](x,n)}
// sibling
let second[U]=func(x U,n int32) U {if n==0{return x}
return first(x,n-1)}
`
        let before = SyntaxTree.Parse(source)
        Assert.Empty(before.Diagnostics)
        let formatted = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(formatted.Diagnostics)
        let after = SyntaxTree.Parse(formatted.Text!!)
        Assert.Empty(after.Diagnostics)
        Assert.Equal(Tokens(before.Root), Tokens(after.Root))
        Assert.False(GSharpFormatter.Format(formatted.Text!!).Changed)
    }

    shared {
        private func Tokens(node SyntaxNode)[]string -> if node is SyntaxToken token {
            []string{token.Kind.ToString() + ":" + token.Text}
        } else {
            node.GetChildren().SelectMany(Tokens).ToArray()
        }
    }
}
