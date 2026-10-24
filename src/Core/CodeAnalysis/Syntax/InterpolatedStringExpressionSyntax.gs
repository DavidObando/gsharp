// <copyright file="InterpolatedStringExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Represents an interpolated string literal expression (e.g. `"hello $name"`
/// or `"sum=${a + b}"`). The token's structured fragments are projected
/// into a mix of literal-text segments and embedded expression segments.
partial class InterpolatedStringExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:InterpolatedStringExpressionSyntax) class.
    /// @param syntaxTree The owning syntax tree.
    /// @param stringToken The interpolated-string token produced by the lexer.
    /// @param segments The mixed text/expression segments.
    init(syntaxTree SyntaxTree, stringToken SyntaxToken, segments ImmutableArray[InterpolatedStringSegment]) : base(
        syntaxTree
    ) {
        StringToken = stringToken
        Segments = segments
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.InterpolatedStringExpression

    /// Gets the node's span: always the full literal (from the opening to the
    /// closing quote). This is pinned to (cref:StringToken) so that
    /// surfacing the hole expressions as children (below) does not shrink the
    /// span to end at the last hole.
    override prop Span TextSpan -> StringToken.Span

    /// Gets a value that tells that this node takes its span from an override, not from its children.
    internal override prop SpanFromChildren bool -> false

    /// Gets the source token.
    prop StringToken SyntaxToken {
        get;
    }

    /// Gets the ordered text/expression segments.
    prop Segments ImmutableArray[InterpolatedStringSegment] {
        get;
    }

    /// Gets the embedded hole expressions (ADR-0055 §C). Exposing them as a
    /// (cref:IEnumerable{T}) of (cref:SyntaxNode) makes the
    /// reflection-based (cref:SyntaxNode.GetChildren) descend into each
    /// hole, so token enumeration, `FindTokenAt`, and the IDE features
    /// built on them (hover, go-to-definition, completion, signature help)
    /// treat a hole as the real, correctly-positioned sub-tree it is.
    prop HoleExpressions IEnumerable[SyntaxNode] -> Segments.Where((s InterpolatedStringSegment) -> s.IsExpression)
        .Select((s InterpolatedStringSegment) -> cast[SyntaxNode](s.Expression!!))
}
