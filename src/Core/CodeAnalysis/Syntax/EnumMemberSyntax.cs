// <copyright file="EnumMemberSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a member in a <c>type Name enum { ... }</c> declaration.
/// </summary>
public sealed class EnumMemberSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EnumMemberSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The enum member identifier.</param>
    public EnumMemberSyntax(SyntaxTree syntaxTree, SyntaxToken identifier)
        : base(syntaxTree)
    {
        Identifier = identifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.EnumMember;

    /// <summary>Gets the enum member identifier.</summary>
    public SyntaxToken Identifier { get; }
}
