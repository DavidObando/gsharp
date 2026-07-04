// <copyright file="BoundLocalFunctionDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound declaration of a generic local function (issue #1886), e.g.
/// <c>let First[T] = func (a T, b T) T { ... }</c>. Unlike an ordinary
/// <see cref="BoundVariableDeclaration"/>, this does not create a runtime
/// variable/delegate value: a CLR delegate cannot close over an unbound
/// generic method, so the wrapped <see cref="Literal"/>'s function is
/// declared directly into the enclosing scope as a callable
/// <see cref="Symbols.FunctionSymbol"/> and calls to it are resolved through
/// ordinary generic overload resolution, not an indirect delegate call.
/// </summary>
public sealed class BoundLocalFunctionDeclaration : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundLocalFunctionDeclaration"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="literal">The bound function literal carrying the generic function's parameters, return type, and body.</param>
    public BoundLocalFunctionDeclaration(SyntaxNode syntax, BoundFunctionLiteralExpression literal)
        : base(syntax)
    {
        Literal = literal;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.LocalFunctionDeclaration;

    /// <summary>
    /// Gets the bound function literal declaring this local function's shape and body.
    /// </summary>
    public BoundFunctionLiteralExpression Literal { get; }
}
