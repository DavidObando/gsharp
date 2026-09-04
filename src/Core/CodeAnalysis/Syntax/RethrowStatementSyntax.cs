// <copyright file="RethrowStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>rethrow</c> statement (ADR-0176, issue #3897).
/// </summary>
/// <remarks>
/// <para><c>rethrow</c> re-raises the exception currently being handled by the
/// lexically innermost enclosing <c>catch</c> clause, emitting
/// <c>ILOpCode.Rethrow</c>. Unlike <c>throw expr</c> (which emits
/// <c>ILOpCode.Throw</c> and resets <see cref="System.Exception.StackTrace"/>
/// to the throw site), a rethrow preserves the original throw site.</para>
/// <para>G# spells this with a dedicated keyword rather than C#'s bare
/// <c>throw;</c>: G# statements are not newline-terminated, so a bare
/// <c>throw</c> followed by a statement on the next line would be parsed as
/// <c>throw &lt;that expression&gt;</c>.</para>
/// </remarks>
public sealed class RethrowStatementSyntax : StatementSyntax
{
    /// <summary>Initializes a new instance of the <see cref="RethrowStatementSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="rethrowKeyword">The <c>rethrow</c> keyword.</param>
    public RethrowStatementSyntax(SyntaxTree syntaxTree, SyntaxToken rethrowKeyword)
        : base(syntaxTree)
    {
        RethrowKeyword = rethrowKeyword;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.RethrowStatement;

    /// <summary>Gets the <c>rethrow</c> keyword.</summary>
    public SyntaxToken RethrowKeyword { get; }
}
