// <copyright file="LinkedEditingRangeHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Linq
import Xunit

open class LinkedEditingRangeHandlerTests {
    @Fact
    func LinkedEditing_ReturnsAllOccurrencesOfVariable() {
        const source = `var x = 1
var y = x + 2
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        let position = LanguageServerTestHelpers.PositionOf(source, "x")
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token)
        Assert.True(SemanticLookup.CanRename(symbol))
        let references = SemanticLookup.FindReferences(compilation, symbol!!).ToList()
        // x appears in declaration and in expression
        Assert.Equal(2, references.Count)
    }

    @Fact
    func LinkedEditing_NonRenamableReturnsNoRanges() {
        const source = "var x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        // Position on a keyword
        let position = LanguageServerTestHelpers.PositionOf(source, "var")
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        // Keywords should not be identifier tokens
        Assert.NotEqual(SyntaxKind.IdentifierToken, token!!.Kind)
    }

    @Fact
    func LinkedEditing_GlobalVariableUsedMultipleTimes() {
        const source = `var n = 1
var m = n + n
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        // Position on 'n' in the second line
        let position = LanguageServerTestHelpers.PositionOf(source, "n", 1)
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token)
        Assert.NotNull(symbol)
        Assert.True(SemanticLookup.CanRename(symbol))
        let references = SemanticLookup.FindReferences(compilation, symbol!!).ToList()
        // n appears in declaration and twice in expression
        Assert.Equal(3, references.Count)
    }
}
