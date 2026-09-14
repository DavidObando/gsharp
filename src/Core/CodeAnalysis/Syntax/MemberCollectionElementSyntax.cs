// <copyright file="MemberCollectionElementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// An explicit receiver member initializer, <c>.Member: value</c>, in an
/// ordered collection initializer (ADR-0180).
/// </summary>
public sealed class MemberCollectionElementSyntax : CollectionElementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="MemberCollectionElementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="dotToken">The explicit receiver marker.</param>
    /// <param name="initializer">The member name, colon, and value.</param>
    public MemberCollectionElementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken dotToken,
        FieldInitializerSyntax initializer)
        : base(syntaxTree)
    {
        DotToken = dotToken;
        Initializer = initializer;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.MemberCollectionElement;

    /// <summary>Gets the explicit receiver marker.</summary>
    public SyntaxToken DotToken { get; }

    /// <summary>Gets the member initializer.</summary>
    public FieldInitializerSyntax Initializer { get; }
}
