// <copyright file="ReferencesHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Linq
import Xunit

open class ReferencesHandlerTests {
    @Fact
    func ComputeReferences_ReturnsAllSingleDocumentOccurrences() {
        const source = `func F(x int32) int32 {
let y = x
return x + y
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///refs.gs")!!
        let references = ReferencesComputer.ComputeReferences(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "x"),
            includeDeclaration: true
        )
        Assert.Equal(3, references.Count)
        Assert.All(references, (r Location) -> Assert.Equal(uri, r.Uri))
    }

    @Fact
    func ComputeReferences_CanExcludeDeclaration() {
        const source = `func F(x int32) int32 {
let y = x
return x + y
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let tokens = ReferencesComputer.ComputeReferenceTokens(
            content,
            LanguageServerTestHelpers.PositionOf(source, "x"),
            includeDeclaration: false
        )
        Assert.Equal(2, tokens.Count)
        Assert.All(tokens, (t SyntaxToken) -> Assert.NotEqual(7, t.Position))
    }

    @Fact
    func ComputeReferences_RepeatedCallsReturnIdenticalResults() {
        // Hot-path regression: SemanticModel now memoizes the Symbol → tokens index
        // so CodeLens (which calls FindReferences once per member) doesn't re-walk
        // every tree on every call. The cache must return identical results across
        // calls; if invalidation logic ever desyncs the cache, this test catches it.
        const source = `func F(x int32) int32 {
let y = x
return x + y + x
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let pos = LanguageServerTestHelpers.PositionOf(source, "x")
        let first = ReferencesComputer.ComputeReferenceTokens(content, pos, includeDeclaration: true)
        let second = ReferencesComputer.ComputeReferenceTokens(content, pos, includeDeclaration: true)
        let third = ReferencesComputer.ComputeReferenceTokens(content, pos, includeDeclaration: true)
        Assert.Equal(first.Count, second.Count)
        Assert.Equal(first.Count, third.Count)
        for var i = 0; i < first.Count; i++ {
            Assert.Equal(first[i].Position, second[i].Position)
            Assert.Equal(first[i].Position, third[i].Position)
        }
    }
}
