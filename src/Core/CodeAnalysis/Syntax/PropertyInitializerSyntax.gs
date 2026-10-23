// <copyright file="PropertyInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #522: a single `PropertyName = value` element inside a C#-style
/// object initializer suffix (`T(args) { P1 = v1, P2 = v2 }`). Distinct
/// from (cref:FieldInitializerSyntax) only in that the property name
/// must bind to a writable instance property/field of the constructed type
/// (init-only setters are allowed); the syntactic shape is identical.
partial class PropertyInitializerSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:PropertyInitializerSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param propertyIdentifier The property name.
    /// @param equalsToken The '=' separator.
    /// @param value The value expression.
    init(syntaxTree SyntaxTree, propertyIdentifier SyntaxToken, equalsToken SyntaxToken, value ExpressionSyntax) : base(
        syntaxTree
    ) {
        PropertyIdentifier = propertyIdentifier
        EqualsToken = equalsToken
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.PropertyInitializer

    /// Gets the property identifier.
    prop PropertyIdentifier SyntaxToken {
        get;
    }

    /// Gets the '=' separator token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the value expression.
    prop Value ExpressionSyntax {
        get;
    }
}
