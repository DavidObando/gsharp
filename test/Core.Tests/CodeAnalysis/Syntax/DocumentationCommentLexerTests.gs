// <copyright file="DocumentationCommentLexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0057 §2: Tests that the lexer emits (cref:SyntaxKind.DocumentationCommentToken)
/// with correct content and positional rules.
open class DocumentationCommentLexerTests {
    @Fact
    func TripleSlash_EmitsDocToken() {
        let tokens = SyntaxTree.ParseTokens("/// Hello")
        let doc = tokens.Single((t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Equal("Hello", cast[string](doc.Value))
    }

    @Fact
    func TripleSlash_NoSpace_ContentStartsAtFourthChar() {
        let tokens = SyntaxTree.ParseTokens("///NoSpace")
        let doc = tokens.Single((t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Equal("NoSpace", cast[string](doc.Value))
    }

    @Fact
    func FourSlashes_ContentIncludesExtraSlash() {
        // //// x → doc content is "/ x" (ADR §2: 4th slash is part of content)
        let tokens = SyntaxTree.ParseTokens("//// extra")
        let doc = tokens.Single((t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Equal("/ extra", cast[string](doc.Value))
    }

    @Fact
    func TripleSlashEquals_ContentIsEquals() {
        // ///= x → content is "= x"
        let tokens = SyntaxTree.ParseTokens("///= x")
        let doc = tokens.Single((t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Equal("= x", cast[string](doc.Value))
    }

    @Fact
    func BlankDocComment_EmptyContent() {
        // /// with nothing after it
        let tokens = SyntaxTree.ParseTokens("///")
        let doc = tokens.Single((t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Equal(string.Empty, cast[string](doc.Value))
    }

    @Fact
    func DoubleSlash_StaysAsRegularComment() {
        let tokens = SyntaxTree.ParseTokens("// regular comment")
        Assert.DoesNotContain(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.CommentToken)
    }

    @Fact
    func MultipleDocComments_OnSeparateLines() {
        let source = "/// Line one\n/// Line two"
        let tokens = SyntaxTree.ParseTokens(source)
        let docs = tokens.Where((t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken).ToArray()
        Assert.Equal(2, docs.Length)
        Assert.Equal("Line one", cast[string](docs[0].Value))
        Assert.Equal("Line two", cast[string](docs[1].Value))
    }

    @Fact
    func DocCommentBeforeCode_DoesNotConsumeCode() {
        let source = "/// doc\nlet x = 1"
        let tokens = SyntaxTree.ParseTokens(source)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.DocumentationCommentToken)
        Assert.Contains(tokens, (t SyntaxToken) -> t.Kind == SyntaxKind.LetKeyword)
    }
}
