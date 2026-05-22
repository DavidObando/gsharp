// <copyright file="InterpolatedStringExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

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

    /// <summary>Gets the source token.</summary>
    public SyntaxToken StringToken { get; }

    /// <summary>Gets the ordered text/expression segments.</summary>
    public ImmutableArray<InterpolatedStringSegment> Segments { get; }
}
