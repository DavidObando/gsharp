#nullable disable

// <copyright file="KeyedCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #479 / ADR-0117: a key/value element of a dictionary collection
/// initializer, e.g. the <c>"a": 1</c> in
/// <c>Dictionary[string, int32]{"a": 1, "b": 2}</c>. Lowers to an
/// <c>Add(key, value)</c> call on the constructed dictionary.
/// </summary>
public sealed class KeyedCollectionElementSyntax : CollectionElementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="KeyedCollectionElementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="key">The key expression.</param>
    /// <param name="colonToken">The <c>:</c> token separating key and value.</param>
    /// <param name="value">The value expression.</param>
    public KeyedCollectionElementSyntax(SyntaxTree syntaxTree, ExpressionSyntax key, SyntaxToken colonToken, ExpressionSyntax value)
        : base(syntaxTree)
    {
        Key = key;
        ColonToken = colonToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.KeyedCollectionElement;

    /// <summary>Gets the key expression.</summary>
    public ExpressionSyntax Key { get; }

    /// <summary>Gets the <c>:</c> token separating key and value.</summary>
    public SyntaxToken ColonToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
