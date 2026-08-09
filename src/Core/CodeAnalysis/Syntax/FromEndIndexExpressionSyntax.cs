// <copyright file="FromEndIndexExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1022: represents a C#-style "from-end" index marker <c>^n</c> used in
/// the leading position of an index or range bound (<c>a[^1]</c>,
/// <c>a[1..^1]</c>, <c>a[^2..]</c>). The offset is measured from the end of the
/// indexed value, mapping to <c>System.Index(n, fromEnd: true)</c> semantics:
/// the concrete offset is <c>length - n</c>.
/// </summary>
/// <remarks>
/// This node is produced only by the index-argument parser, so the prefix
/// <c>^</c> one's-complement and infix <c>^</c> bitwise-XOR meanings of the hat
/// token are unchanged everywhere else in the grammar.
/// </remarks>
public sealed class FromEndIndexExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FromEndIndexExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="hatToken">The leading <c>^</c> marker token.</param>
    /// <param name="operand">The from-end offset expression (<c>n</c> in <c>^n</c>).</param>
    public FromEndIndexExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken hatToken,
        ExpressionSyntax operand)
        : base(syntaxTree)
    {
        HatToken = hatToken;
        Operand = operand;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FromEndIndexExpression;

    /// <summary>Gets the leading <c>^</c> marker token.</summary>
    public SyntaxToken HatToken { get; }

    /// <summary>Gets the from-end offset expression.</summary>
    public ExpressionSyntax Operand { get; }
}
