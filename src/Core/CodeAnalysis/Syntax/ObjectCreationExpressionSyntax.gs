// <copyright file="ObjectCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #522: a constructor invocation with a trailing C#-style object
/// initializer, e.g. `WithInit(args) { Asin = "X", Title = "T" }` or
/// `List[int](){ Capacity = 16 }`. The (cref:Target) is the
/// already-parsed call expression (positional + named ctor args); each
/// element in (cref:Initializers) assigns a property/field on the
/// constructed instance. The binder lowers this to a
/// (cref:GSharp.Core.CodeAnalysis.Binding.BoundBlockExpression) that
/// constructs into a synthetic local, performs the assignments, and yields
/// the local — so init-only setters are legal here even though they would be
/// disallowed at a free-standing assignment site.
class ObjectCreationExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ObjectCreationExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The underlying constructor call expression.
    /// @param openBraceToken The '{' opening the initializer list.
    /// @param initializers The property initializers.
    /// @param closeBraceToken The matching '}'.
    init(
        syntaxTree SyntaxTree,
        target ExpressionSyntax?,
        openBraceToken SyntaxToken,
        initializers SeparatedSyntaxList[PropertyInitializerSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        Target = target
        OpenBraceToken = openBraceToken
        Initializers = initializers
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ObjectCreationExpression

    /// Gets the underlying constructor call expression (a (cref:CallExpressionSyntax)).
    prop Target ExpressionSyntax? {
        get;
    }

    /// Gets the '{' opening the initializer list.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the property initializers (zero or more).
    prop Initializers SeparatedSyntaxList[PropertyInitializerSyntax] {
        get;
    }

    /// Gets the '}' closing the initializer list.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
