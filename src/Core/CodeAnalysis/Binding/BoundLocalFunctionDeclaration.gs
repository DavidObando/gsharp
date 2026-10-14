// <copyright file="BoundLocalFunctionDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound declaration of a generic local function (issue #1886), e.g.
/// `let First[T] = func (a T, b T) T { ... }`. Unlike an ordinary
/// (cref:BoundVariableDeclaration), this does not create a runtime
/// variable/delegate value: a CLR delegate cannot close over an unbound
/// generic method, so the wrapped (cref:Literal)'s function is
/// declared directly into the enclosing scope as a callable
/// (cref:Symbols.FunctionSymbol) and calls to it are resolved through
/// ordinary generic overload resolution, not an indirect delegate call.
class BoundLocalFunctionDeclaration : BoundStatement {
    /// Initializes a new instance of the (cref:BoundLocalFunctionDeclaration) class.
    /// @param syntax The originating syntax.
    /// @param literal The bound function literal carrying the generic function's parameters, return type,
    /// and body.
    init(syntax SyntaxNode?, literal BoundFunctionLiteralExpression) : base(syntax) {
        literal.Function.IsLocalFunction = true
        Literal = literal
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.LocalFunctionDeclaration

    /// Gets the bound function literal declaring this local function's shape and body.
    prop Literal BoundFunctionLiteralExpression {
        get;
    }
}
