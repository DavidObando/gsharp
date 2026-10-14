// <copyright file="BoundVariableDeclaration.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound variable declaration.
class BoundVariableDeclaration : BoundStatement {
    /// Initializes a new instance of the (cref:BoundVariableDeclaration) class.
    /// @param syntax The originating syntax.
    /// @param variable The variable symbol.
    /// @param initializer The bound initializer expression, or
    /// `null` for a declaration with no initializer.
    /// @param constantValue The compile-time constant value when this is a `const` declaration
    /// whose initializer folds to a literal; `null` otherwise.
    /// When non-null the emitter will not allocate an IL slot for the variable
    /// and will instead inline the value at every read site, emitting a
    /// `LocalConstant` row in the Portable PDB.
    init(syntax SyntaxNode?, variable VariableSymbol, initializer BoundExpression?, constantValue object? = nil) : base(
        syntax
    ) {
        Variable = variable
        Initializer = initializer
        ConstantValue = constantValue
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.VariableDeclaration

    /// Gets the variable symbol.
    prop Variable VariableSymbol {
        get;
    }

    /// Gets the bound expression.
    prop Initializer BoundExpression? {
        get;
    }

    /// Gets the compile-time constant value for this declaration, or
    /// `null` when the declaration is not a compile-time
    /// constant (i.e. it was declared with `var` or `let`, or the
    /// `const` initializer is not a literal expression). When non-null,
    /// no IL local slot is allocated and the value is inlined at every read
    /// site, with a `LocalConstant` row emitted in the Portable PDB.
    prop ConstantValue object? {
        get;
    }
}
