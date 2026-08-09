// <copyright file="AnnotationTargetSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the optional use-site target qualifier on an annotation
/// (ADR-0047 §4): the <c>field</c>, <c>param</c>, <c>return</c>, <c>type</c>,
/// <c>method</c>, <c>property</c>, <c>event</c>, <c>module</c>,
/// <c>assembly</c>, or <c>genericparam</c> identifier that immediately
/// follows <c>@</c> and is terminated by <c>:</c>.
///
/// The kind keywords are *contextual* — they are ordinary identifiers
/// everywhere else in the language; the lexer does not promote them.
/// </summary>
public sealed class AnnotationTargetSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="AnnotationTargetSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="kindIdentifier">The contextual target-kind identifier (e.g. <c>field</c>).</param>
    /// <param name="colonToken">The trailing <c>:</c> token.</param>
    public AnnotationTargetSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken kindIdentifier,
        SyntaxToken colonToken)
        : base(syntaxTree)
    {
        KindIdentifier = kindIdentifier;
        ColonToken = colonToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnnotationTarget;

    /// <summary>Gets the contextual target-kind identifier (its <see cref="SyntaxToken.Text"/> is the canonical kind name).</summary>
    public SyntaxToken KindIdentifier { get; }

    /// <summary>Gets the trailing <c>:</c> token.</summary>
    public SyntaxToken ColonToken { get; }
}
