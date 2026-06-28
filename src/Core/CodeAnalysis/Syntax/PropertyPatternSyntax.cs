#nullable disable

// <copyright file="PropertyPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a property pattern <c>{ Name: pattern }</c>.</summary>
public sealed class PropertyPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="PropertyPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBraceToken">The opening brace token.</param>
    /// <param name="fields">The field patterns.</param>
    /// <param name="closeBraceToken">The closing brace token.</param>
    public PropertyPatternSyntax(SyntaxTree syntaxTree, SyntaxToken openBraceToken, SeparatedSyntaxList<PropertyPatternFieldSyntax> fields, SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        OpenBraceToken = openBraceToken;
        Fields = fields;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.PropertyPattern;

    /// <summary>Gets the opening brace token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field patterns.</summary>
    public SeparatedSyntaxList<PropertyPatternFieldSyntax> Fields { get; }

    /// <summary>Gets the closing brace token.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
