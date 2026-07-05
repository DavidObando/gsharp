// <copyright file="StaticInitializerBlockSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an <c>init { … }</c> static-initializer block declared inside a
/// <c>shared { … }</c> block (ADR-0140 / issue #2131). Its statements run in the
/// containing type's <c>.cctor</c> (static constructor) after the static-field
/// initializers, matching a C# static constructor body.
/// </summary>
public sealed class StaticInitializerBlockSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StaticInitializerBlockSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="initKeyword">The contextual <c>init</c> identifier token.</param>
    /// <param name="body">The block of statements executed in the type initializer.</param>
    public StaticInitializerBlockSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken initKeyword,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        InitKeyword = initKeyword;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StaticInitializerBlock;

    /// <summary>Gets the contextual <c>init</c> identifier token.</summary>
    public SyntaxToken InitKeyword { get; }

    /// <summary>Gets the block of statements executed in the type initializer.</summary>
    public BlockStatementSyntax Body { get; }
}
