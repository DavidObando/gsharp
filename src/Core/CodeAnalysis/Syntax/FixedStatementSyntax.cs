#nullable disable

// <copyright file="FixedStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0125 / issue #1026: a <c>fixed</c> (pinning) statement
/// <c>fixed name *T = source { … }</c>. It pins a managed array or string
/// <c>source</c> for the duration of the block and binds an unmanaged pointer
/// <c>*T</c> (<see cref="TypeClause"/>, only spellable inside an <c>unsafe</c>
/// context per ADR-0122) into the first element of the pinned buffer. The pin
/// is emitted as a CLR pinned local, mirroring C# <c>fixed (T* p = expr) { … }</c>.
/// </summary>
/// <remarks>
/// The paren-less header (<c>fixed name *T = source</c>) follows the same
/// shape as G#'s other statement headers (<c>if</c>, <c>for</c>, <c>while</c>,
/// <c>unsafe { }</c>). <c>fixed</c> is a contextual keyword — the parser only
/// commits to this form for the exact <c>fixed IDENT *</c> shape, so existing
/// identifiers named <c>fixed</c> are unaffected.
/// </remarks>
public sealed class FixedStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FixedStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="fixedKeyword">The contextual <c>fixed</c> keyword token.</param>
    /// <param name="identifier">The pointer-binding identifier.</param>
    /// <param name="typeClause">The unmanaged pointer type clause (<c>*T</c>).</param>
    /// <param name="equalsToken">The <c>=</c> token.</param>
    /// <param name="pinnedSource">The managed array/string source expression to pin.</param>
    /// <param name="body">The block over which the pin is held.</param>
    public FixedStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken fixedKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax typeClause,
        SyntaxToken equalsToken,
        ExpressionSyntax pinnedSource,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        FixedKeyword = fixedKeyword;
        Identifier = identifier;
        TypeClause = typeClause;
        EqualsToken = equalsToken;
        PinnedSource = pinnedSource;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FixedStatement;

    /// <summary>Gets the contextual <c>fixed</c> keyword token.</summary>
    public SyntaxToken FixedKeyword { get; }

    /// <summary>Gets the pointer-binding identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the unmanaged pointer type clause (<c>*T</c>).</summary>
    public TypeClauseSyntax TypeClause { get; }

    /// <summary>Gets the <c>=</c> token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the managed array/string source expression to pin.</summary>
    public ExpressionSyntax PinnedSource { get; }

    /// <summary>Gets the block over which the pin is held.</summary>
    public BlockStatementSyntax Body { get; }
}
