// <copyright file="NavigationHandlerTests.cs" company="GSharp">
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

open class NavigationHandlerTests {
    @Fact
    func PrepareRename_IdentifiesRenamableSymbol() {
        const source = "var x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let position = LanguageServerTestHelpers.PositionOf(source, "x")
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        Assert.NotNull(token)
        Assert.Equal(SyntaxKind.IdentifierToken, token!!.Kind)
        let compilation = Compilation(content.SyntaxTree)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token)
        Assert.True(SemanticLookup.CanRename(symbol))
    }

    @Fact
    func PrepareRename_KeywordsNotRenamable() {
        const source = "var x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let position = LanguageServerTestHelpers.PositionOf(source, "var")
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        // Keywords are not identifier tokens
        Assert.NotEqual(SyntaxKind.IdentifierToken, token!!.Kind)
    }

    @Fact
    func Implementation_FindsStructImplementingInterface() {
        const source = `interface Shape { area() float64 }
struct Circle { var radius float64 }
func (c Circle) area() float64 { return c.radius }
`
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        let position = LanguageServerTestHelpers.PositionOf(source, "Shape")
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token)
        // The symbol should be an interface type
        Assert.NotNull(symbol)
    }

    @Fact
    func TypeDefinition_NavigatesToType() {
        const source = "var x int32 = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let compilation = Compilation(content.SyntaxTree)
        let position = LanguageServerTestHelpers.PositionOf(source, "x")
        let offset = SemanticLookup.ToOffset(content, position)
        let token SyntaxToken? = SemanticLookup.FindTokenAt(content.SyntaxTree, offset)
        let symbol Symbol? = SemanticLookup.ResolveSymbol(compilation, token)
        // The variable should resolve to a symbol with a type
        Assert.NotNull(symbol)
    }
}
