// <copyright file="NamedArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a named argument expression <c>Name = value</c>. Named arguments
/// originate at three kinds of call site:
/// <list type="bullet">
///   <item><description>The scoped <c>.copy(field = value, ...)</c> sugar.</description></item>
///   <item><description>Attribute argument lists (<c>[Attr(prop = value)]</c>).</description></item>
///   <item><description>Issue #343: ordinary call sites — free functions, user methods, user
///   constructors, user extension functions, imported CLR static/instance methods, imported
///   CLR constructors, imported extension methods, and inherited CLR instance methods —
///   accept named arguments interchangeably with positional ones. The binder reorders
///   bound arguments into parameter order before per-position processing.</description></item>
/// </list>
/// </summary>
public sealed class NamedArgumentExpressionSyntax : ExpressionSyntax
{
    /// <summary>Initializes a new instance of the <see cref="NamedArgumentExpressionSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="nameToken">The argument name.</param>
    /// <param name="equalsToken">The equals separator.</param>
    /// <param name="expression">The argument value.</param>
    public NamedArgumentExpressionSyntax(SyntaxTree syntaxTree, SyntaxToken nameToken, SyntaxToken equalsToken, ExpressionSyntax expression)
        : base(syntaxTree)
    {
        NameToken = nameToken;
        EqualsToken = equalsToken;
        Expression = expression;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.NamedArgumentExpression;

    /// <summary>Gets the argument name.</summary>
    public SyntaxToken NameToken { get; }

    /// <summary>Gets the equals separator.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the argument value.</summary>
    public ExpressionSyntax Expression { get; }
}
