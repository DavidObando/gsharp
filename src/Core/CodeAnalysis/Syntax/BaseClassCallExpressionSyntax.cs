// <copyright file="BaseClassCallExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents the canonical non-virtual base-class call <c>base.Method(args)</c>.
/// </summary>
public sealed class BaseClassCallExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="BaseClassCallExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="baseKeyword">The contextual <c>base</c> token.</param>
    /// <param name="dotToken">The member-access dot.</param>
    /// <param name="call">The method call following the dot.</param>
    public BaseClassCallExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken baseKeyword,
        SyntaxToken dotToken,
        CallExpressionSyntax call)
        : base(syntaxTree)
    {
        BaseKeyword = baseKeyword;
        DotToken = dotToken;
        Call = call;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.BaseClassCallExpression;

    /// <summary>Gets the contextual <c>base</c> token.</summary>
    public SyntaxToken BaseKeyword { get; }

    /// <summary>Gets the member-access dot.</summary>
    public SyntaxToken DotToken { get; }

    /// <summary>Gets the method call following the dot.</summary>
    public CallExpressionSyntax Call { get; }
}
