// <copyright file="UnicodeIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 1.7: identifiers follow Go's Unicode-letter rules.
/// - Start: Unicode letter (categories Lu/Ll/Lt/Lm/Lo/Nl) or '_'.
/// - Continue: Unicode letter, decimal digit (Nd), or '_'.
/// .NET's `char.IsLetter` / `char.IsLetterOrDigit` are
/// Unicode-aware, so this is a verification + policy test set.
open class UnicodeIdentifierTests {
    @Theory
    @InlineData("café")
    @InlineData("π")
    @InlineData("日本語")
    @InlineData("Москва")
    @InlineData("Δx")
    @InlineData("naïve")
    @InlineData("_underscore")
    @InlineData("α2β")
    func Lexes_Unicode_Identifier_As_Single_Token(identifier string) {
        let tokens = SyntaxTree.ParseTokens(identifier).ToArray()
        Assert.Single(tokens)
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[0].Kind)
        Assert.Equal(identifier, tokens[0].Text)
    }

    @Fact
    func Identifier_Cannot_Start_With_Digit() {
        let tokens = SyntaxTree.ParseTokens("2π").ToArray()
        Assert.Equal(2, tokens.Length)
        Assert.Equal(SyntaxKind.NumberToken, tokens[0].Kind)
        Assert.Equal(SyntaxKind.IdentifierToken, tokens[1].Kind)
        Assert.Equal("π", tokens[1].Text)
    }

    @Fact
    func Unicode_Identifier_Binds_Correctly() {
        let source = `func F() {
 let π = 3
 let twoπ = π + π
 }
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
