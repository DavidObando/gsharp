#nullable disable

// <copyright file="FieldInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single <c>FieldName: value</c> element inside a struct composite
/// literal (Phase 3.B.1), or <c>FieldName = value</c> in data-struct copy sugar.
/// </summary>
public sealed class FieldInitializerSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldInitializerSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="fieldIdentifier">The field name.</param>
    /// <param name="colonToken">The field/value separator.</param>
    /// <param name="value">The value expression.</param>
    public FieldInitializerSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken fieldIdentifier,
        SyntaxToken colonToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        FieldIdentifier = fieldIdentifier;
        ColonToken = colonToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FieldInitializer;

    /// <summary>Gets the field identifier.</summary>
    public SyntaxToken FieldIdentifier { get; }

    /// <summary>Gets the field/value separator token.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
