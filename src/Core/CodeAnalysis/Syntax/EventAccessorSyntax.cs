#nullable disable

// <copyright file="EventAccessorSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single <c>add</c> or <c>remove</c> accessor inside an event body (ADR-0052).
/// </summary>
public sealed class EventAccessorSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EventAccessorSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessorKeyword">The <c>add</c> or <c>remove</c> identifier token.</param>
    /// <param name="body">The optional block body.</param>
    /// <param name="semicolonToken">The optional semicolon (for shorthand <c>add;</c> / <c>remove;</c>).</param>
    public EventAccessorSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessorKeyword,
        BlockStatementSyntax body,
        SyntaxToken semicolonToken)
        : base(syntaxTree)
    {
        AccessorKeyword = accessorKeyword;
        Body = body;
        SemicolonToken = semicolonToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.EventAccessor;

    /// <summary>Gets the <c>add</c> or <c>remove</c> identifier token.</summary>
    public SyntaxToken AccessorKeyword { get; }

    /// <summary>Gets the optional block body. Null for bare <c>add;</c> / <c>remove;</c> accessors.</summary>
    public BlockStatementSyntax Body { get; }

    /// <summary>Gets the optional semicolon token (present for <c>add;</c> / <c>remove;</c> shorthand).</summary>
    public SyntaxToken SemicolonToken { get; }

    /// <summary>Gets a value indicating whether this accessor is an <c>add</c> accessor.</summary>
    public bool IsAdd => AccessorKeyword?.Text == "add";

    /// <summary>Gets a value indicating whether this accessor is a <c>remove</c> accessor.</summary>
    public bool IsRemove => AccessorKeyword?.Text == "remove";

    /// <summary>Gets a value indicating whether this accessor is a <c>raise</c> accessor (issue #257).</summary>
    public bool IsRaise => AccessorKeyword?.Text == "raise";
}
