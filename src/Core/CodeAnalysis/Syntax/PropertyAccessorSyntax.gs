// <copyright file="PropertyAccessorSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a single `get`, `set`, or `init` accessor inside a property body (ADR-0051, issue #946).
partial class PropertyAccessorSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:PropertyAccessorSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessor accessibility modifier.
    /// @param accessorKeyword The `get` or `set` identifier token.
    /// @param openParenToken The optional open parenthesis (for `set(value)`).
    /// @param parameterIdentifier The optional parameter identifier (for `set(value)`).
    /// @param closeParenToken The optional close parenthesis (for `set(value)`).
    /// @param body The optional block body.
    /// @param semicolonToken The optional semicolon (for shorthand `get;` / `set;`).
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        accessorKeyword SyntaxToken,
        openParenToken SyntaxToken?,
        parameterIdentifier SyntaxToken?,
        closeParenToken SyntaxToken?,
        body BlockStatementSyntax?,
        semicolonToken SyntaxToken?
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        AccessorKeyword = accessorKeyword
        OpenParenToken = openParenToken
        ParameterIdentifier = parameterIdentifier
        CloseParenToken = closeParenToken
        Body = body
        SemicolonToken = semicolonToken
    }

    /// Gets the optional accessor accessibility modifier.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.PropertyAccessor

    /// Gets the `get` or `set` identifier token.
    prop AccessorKeyword SyntaxToken {
        get;
    }

    /// Gets the optional open parenthesis token (only for `set(value)`).
    prop OpenParenToken SyntaxToken? {
        get;
    }

    /// Gets the optional parameter identifier (only for `set(value)`).
    prop ParameterIdentifier SyntaxToken? {
        get;
    }

    /// Gets the optional close parenthesis token (only for `set(value)`).
    prop CloseParenToken SyntaxToken? {
        get;
    }

    /// Gets the optional block body. Null for bare `get;` or bodyless accessors.
    prop Body BlockStatementSyntax? {
        get;
    }

    /// Gets the optional semicolon token (present for `get;` / `set;` shorthand).
    prop SemicolonToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this accessor is a getter.
    prop IsGetter bool -> AccessorKeyword?.Text == "get"

    /// Gets a value indicating whether this accessor is a setter.
    prop IsSetter bool -> AccessorKeyword?.Text == "set"

    /// Gets a value indicating whether this accessor is an `init`-only
    /// setter (issue #946). An `init` accessor is emitted as a
    /// `set_Prop` method whose void return carries the
    /// `IsExternalInit` modreq; assignment is restricted to object
    /// initialization (constructors, object initializers, and other
    /// `init` accessors).
    prop IsInit bool -> AccessorKeyword?.Text == "init"

    /// Gets a value indicating whether this accessor writes the property (a `set` or an `init` accessor).
    prop IsSetterOrInit bool -> IsSetter || IsInit
}
