// <copyright file="GuardLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>guard let name = expr [, let n2 = e2]* else { else }</c>
/// statement (ADR-0071 / issue #708). The new bindings extend the enclosing
/// block's scope; the else-block must unconditionally exit the enclosing
/// region (return / throw / break / continue) — see GS0297.
/// </summary>
public sealed class GuardLetStatementSyntax : StatementSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GuardLetStatementSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="guardKeyword">The <c>guard</c> keyword token.</param>
    /// <param name="bindings">The comma-separated list of <c>let</c> bindings.</param>
    /// <param name="elseKeyword">The <c>else</c> keyword token.</param>
    /// <param name="elseStatement">The else-block (must terminate the enclosing scope).</param>
    public GuardLetStatementSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken guardKeyword,
        SeparatedSyntaxList<IfLetBindingClauseSyntax> bindings,
        SyntaxToken elseKeyword,
        StatementSyntax elseStatement)
        : base(syntaxTree)
    {
        GuardKeyword = guardKeyword;
        Bindings = bindings;
        ElseKeyword = elseKeyword;
        ElseStatement = elseStatement;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.GuardLetStatement;

    /// <summary>Gets the <c>guard</c> keyword token.</summary>
    public SyntaxToken GuardKeyword { get; }

    /// <summary>Gets the comma-separated list of bindings.</summary>
    public SeparatedSyntaxList<IfLetBindingClauseSyntax> Bindings { get; }

    /// <summary>Gets the <c>else</c> keyword token.</summary>
    public SyntaxToken ElseKeyword { get; }

    /// <summary>Gets the else-block; required and must unconditionally exit the enclosing scope.</summary>
    public StatementSyntax ElseStatement { get; }
}
