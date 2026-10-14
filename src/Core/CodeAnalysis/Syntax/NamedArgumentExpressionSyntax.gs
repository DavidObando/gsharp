// <copyright file="NamedArgumentExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a named argument expression. Ordinary calls use
/// `Name: value`; attribute lists additionally use C#'s
/// `Name = value` spelling for property/field assignments. Named
/// arguments originate at three
/// kinds of call site:
/// - The scoped `.copy(field: value, ...)` sugar (ADR-0032).
/// - Attribute argument lists (`[Attr(parameter: value, Property = value)]`, ADR-0047).
/// - Issue #343: ordinary call sites — free functions, user methods, user constructors, user extension
/// functions, imported CLR static/instance methods, imported CLR constructors, imported extension
/// methods, and inherited CLR instance methods — accept named arguments interchangeably with positional
/// ones. The binder reorders bound arguments into parameter order before per-position processing.
class NamedArgumentExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:NamedArgumentExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param nameToken The argument name.
    /// @param equalsToken The separator token: `:`, or attribute-specific `=` for a property/field.
    /// @param expression The argument value.
    init(syntaxTree SyntaxTree, nameToken SyntaxToken, equalsToken SyntaxToken, expression ExpressionSyntax) : base(
        syntaxTree
    ) {
        NameToken = nameToken
        EqualsToken = equalsToken
        Expression = expression
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NamedArgumentExpression

    /// Gets the argument name.
    prop NameToken SyntaxToken {
        get;
    }

    /// Gets the separator token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the argument value.
    prop Expression ExpressionSyntax {
        get;
    }
}
