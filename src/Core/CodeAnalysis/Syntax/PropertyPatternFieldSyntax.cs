#nullable disable

// <copyright file="PropertyPatternFieldSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents one field in a property pattern.</summary>
public sealed class PropertyPatternFieldSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="PropertyPatternFieldSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The field identifier.</param>
    /// <param name="colonToken">The colon token.</param>
    /// <param name="pattern">The nested pattern.</param>
    public PropertyPatternFieldSyntax(SyntaxTree syntaxTree, SyntaxToken identifier, SyntaxToken colonToken, PatternSyntax pattern)
        : base(syntaxTree)
    {
        Identifier = identifier;
        ColonToken = colonToken;
        Pattern = pattern;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.PropertyPatternField;

    /// <summary>Gets the field identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the colon token.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the nested pattern.</summary>
    public PatternSyntax Pattern { get; }
}
