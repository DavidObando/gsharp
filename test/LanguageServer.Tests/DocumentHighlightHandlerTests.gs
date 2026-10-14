// <copyright file="DocumentHighlightHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import Xunit

open class DocumentHighlightHandlerTests {
    @Fact
    func ComputeHighlights_ReturnsAllOccurrences() {
        const source = `func F(x int32) int32 {
let y = x
return x + y
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = ReferencesComputer.ComputeReferenceTokens(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x"),
            includeDeclaration: true
        )
        Assert.Equal(3, tokens.Count)
    }

    @Fact
    func ComputeHighlights_NoSymbol_ReturnsEmpty() {
        const source = "let x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = ReferencesComputer.ComputeReferenceTokens(
            content,
            LanguageServerTestHelpers.PositionOf(source, "42"),
            includeDeclaration: true
        )
        Assert.Empty(tokens)
    }
}
