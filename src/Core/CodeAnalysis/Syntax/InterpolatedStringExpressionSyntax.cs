#nullable disable

// <copyright file="InterpolatedStringExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an interpolated string literal expression (e.g. <c>"hello $name"</c>
/// or <c>"sum=${a + b}"</c>). The token's structured fragments are projected
/// into a mix of literal-text segments and embedded expression segments.
/// </summary>
public sealed class InterpolatedStringExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="InterpolatedStringExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The owning syntax tree.</param>
    /// <param name="stringToken">The interpolated-string token produced by the lexer.</param>
    /// <param name="segments">The mixed text/expression segments.</param>
    public InterpolatedStringExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken stringToken,
        ImmutableArray<InterpolatedStringSegment> segments)
        : base(syntaxTree)
    {
        StringToken = stringToken;
        Segments = segments;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.InterpolatedStringExpression;

    /// <summary>
    /// Gets the node's span: always the full literal (from the opening to the
    /// closing quote). This is pinned to <see cref="StringToken"/> so that
    /// surfacing the hole expressions as children (below) does not shrink the
    /// span to end at the last hole.
    /// </summary>
    public override Text.TextSpan Span => StringToken.Span;

    /// <summary>Gets the source token.</summary>
    public SyntaxToken StringToken { get; }

    /// <summary>Gets the ordered text/expression segments.</summary>
    public ImmutableArray<InterpolatedStringSegment> Segments { get; }

    /// <summary>
    /// Gets the embedded hole expressions (ADR-0055 §C). Exposing them as a
    /// <see cref="IEnumerable{T}"/> of <see cref="SyntaxNode"/> makes the
    /// reflection-based <see cref="SyntaxNode.GetChildren"/> descend into each
    /// hole, so token enumeration, <c>FindTokenAt</c>, and the IDE features
    /// built on them (hover, go-to-definition, completion, signature help)
    /// treat a hole as the real, correctly-positioned sub-tree it is.
    /// </summary>
    public IEnumerable<SyntaxNode> HoleExpressions =>
        Segments.Where(s => s.IsExpression).Select(s => (SyntaxNode)s.Expression);
}
