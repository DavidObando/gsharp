#nullable disable

// <copyright file="MapEntrySyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single <c>key: value</c> entry inside a map literal
/// <c>map[K,V]{ … }</c> (ADR-0104).
/// </summary>
public sealed class MapEntrySyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="MapEntrySyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="key">The key expression.</param>
    /// <param name="colonToken">The colon separator.</param>
    /// <param name="value">The value expression.</param>
    public MapEntrySyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax key,
        SyntaxToken colonToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Key = key;
        ColonToken = colonToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MapEntry;

    /// <summary>Gets the key expression.</summary>
    public ExpressionSyntax Key { get; }

    /// <summary>Gets the <c>:</c> separator token.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
