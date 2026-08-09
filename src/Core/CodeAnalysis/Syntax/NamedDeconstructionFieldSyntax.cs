// <copyright file="NamedDeconstructionFieldSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents one <c>Field = local</c> binding inside named data-struct deconstruction.
/// </summary>
public sealed class NamedDeconstructionFieldSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="NamedDeconstructionFieldSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="fieldIdentifier">The field name.</param>
    /// <param name="equalsToken">The equals separator.</param>
    /// <param name="localIdentifier">The local identifier to declare.</param>
    public NamedDeconstructionFieldSyntax(SyntaxTree syntaxTree, SyntaxToken fieldIdentifier, SyntaxToken equalsToken, SyntaxToken localIdentifier)
        : base(syntaxTree)
    {
        FieldIdentifier = fieldIdentifier;
        EqualsToken = equalsToken;
        LocalIdentifier = localIdentifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NamedDeconstructionField;

    /// <summary>Gets the field name.</summary>
    public SyntaxToken FieldIdentifier { get; }

    /// <summary>Gets the equals separator.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the local identifier to declare.</summary>
    public SyntaxToken LocalIdentifier { get; }
}
