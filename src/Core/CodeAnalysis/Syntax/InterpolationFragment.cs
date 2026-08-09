// <copyright file="InterpolationFragment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A raw fragment produced by the lexer for an interpolated string literal.
/// Stored as the <c>Value</c> of an <see cref="SyntaxKind.InterpolatedStringToken"/>.
/// Expression fragments still hold un-parsed text; the parser is responsible
/// for lexing+parsing them into <see cref="ExpressionSyntax"/> nodes when it
/// builds an <see cref="InterpolatedStringExpressionSyntax"/>.
/// </summary>
public readonly struct InterpolationFragment
{
    private InterpolationFragment(bool isExpression, string text, int position)
    {
        IsExpression = isExpression;
        Text = text;
        Position = position;
    }

    /// <summary>Gets a value indicating whether this fragment is an expression (true) or literal text (false).</summary>
    public bool IsExpression { get; }

    /// <summary>Gets the fragment's source text (literal content or un-parsed expression source).</summary>
    public string Text { get; }

    /// <summary>Gets the position in the original source where the fragment text begins (used for diagnostics on expression fragments).</summary>
    public int Position { get; }

    /// <summary>Creates a literal-text fragment.</summary>
    /// <param name="text">Literal text.</param>
    /// <returns>The fragment.</returns>
    public static InterpolationFragment FromText(string text) => new(isExpression: false, text, position: 0);

    /// <summary>Creates an expression fragment whose <paramref name="text"/> still needs parsing.</summary>
    /// <param name="text">Un-parsed expression source.</param>
    /// <param name="position">Position in the enclosing source text where the expression starts.</param>
    /// <returns>The fragment.</returns>
    public static InterpolationFragment FromExpression(string text, int position) => new(isExpression: true, text, position);
}
