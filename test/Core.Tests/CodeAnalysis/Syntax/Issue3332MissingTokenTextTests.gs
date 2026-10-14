// <copyright file="Issue3332MissingTokenTextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #3332 (part of #1364): a token the parser inserts during error
/// recovery carries (cref:string.Empty) as its text, never
/// `null`, and reports (cref:SyntaxToken.IsMissing)
/// separately.
///
/// Before this change `IsMissing` was defined as `Text == null`, so
/// every consumer of `token.Text` could dereference null on any recovery
/// path — the shape that produced issue #2144. Making the text empty removes
/// that hazard; keeping `IsMissing` as its own flag preserves the
/// distinction it encoded, which CodeLens, SemanticLookup and function
/// declaration in the binder all depend on.
open class Issue3332MissingTokenTextTests {
    /// The discriminating assertion: `Text` is empty rather than null.
    /// This is RED before the change (Text is null) and green after.
    @Fact
    func MissingToken_HasEmptyTextRatherThanNull() {
        // `func` with no name: the parser reports the unexpected token and
        // synthesises the identifier it wanted.
        let tree = SyntaxTree.Parse("func (")
        let missing = AllTokens(tree).Where((t SyntaxToken) -> t.IsMissing).ToList()
        Assert.NotEmpty(missing)
        Assert.All(missing, (t SyntaxToken) -> Assert.Equal(string.Empty, t.Text))
        Assert.All(missing, (t SyntaxToken) -> Assert.NotNull(t.Text))
    }

    /// The regression guard: `IsMissing` must keep discriminating once it
    /// no longer reads `Text == null`. Without this, defining missing
    /// tokens as empty-texted would silently make `IsMissing` false
    /// everywhere and re-enable code lenses and name lookups on tokens that do
    /// not exist in source.
    @Fact
    func IsMissing_StillDistinguishesSynthesisedFromRealTokens() {
        let broken = SyntaxTree.Parse("func (")
        let wellFormed = SyntaxTree.Parse("func f() { }")
        Assert.Contains(AllTokens(broken), (t SyntaxToken) -> t.IsMissing)
        Assert.DoesNotContain(AllTokens(wellFormed), (t SyntaxToken) -> t.IsMissing)
    }

    /// A missing token occupies no source, so its span stays zero-width. The
    /// old `Text?.Length ?? 0` produced that from null; an empty string
    /// must produce the same.
    @Fact
    func MissingToken_SpanRemainsZeroWidth() {
        let tree = SyntaxTree.Parse("func (")
        Assert.All(
            AllTokens(tree).Where((t SyntaxToken) -> t.IsMissing),
            (t SyntaxToken) -> Assert.Equal(0, t.Span.Length)
        )
    }

    /// A real token is unaffected: it keeps its source text and is not missing.
    /// Pairs the quantifier in the tests above, which would otherwise pass on a
    /// tree with no tokens at all (ADR-0154 anti-pattern 5).
    @Fact
    func RealToken_KeepsItsSourceText() {
        let tree = SyntaxTree.Parse("func f() { }")
        let identifier = AllTokens(tree).Single(
            (t SyntaxToken) -> t.Kind == SyntaxKind.IdentifierToken && t.Text == "f"
        )
        Assert.False(identifier.IsMissing)
    }

    shared {
        private func AllTokens(tree SyntaxTree) IEnumerable[SyntaxToken] -> Descend(tree.Root).OfType[SyntaxToken]()

        private func Descend(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descend(child) {
                    yield descendant
                }
            }
        }
    }
}
