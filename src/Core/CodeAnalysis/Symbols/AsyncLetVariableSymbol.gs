// <copyright file="AsyncLetVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax

/// The binding introduced by `async let name = expr` (ADR-0174 D15). Its
/// type is the child's logical result `R`, not a task — the binding is not
/// a value, which is what keeps a spawn from outliving the `scope` that
/// owns it.
/// @remarks Every read is spelled `await name`, and the compiler turns that into a
/// read of (cref:Cell). Any other mention of the name is GS0569: the
/// value may not have arrived, and D4's discipline is that suspension is
/// visible at the point it happens.
class AsyncLetVariableSymbol : LocalVariableSymbol {
    /// Initializes a new instance of the (cref:AsyncLetVariableSymbol) class.
    /// @param name The binding's name.
    /// @param type The child's result type.
    /// @param cell The synthesized `AsyncLetCell[R]` local the child deposits into.
    /// @param declaringSyntax The identifier that declared it.
    init(name string, type TypeSymbol, cell VariableSymbol, declaringSyntax SyntaxNode? = nil) : base(
        name,
        true,
        type,
        declaringSyntax
    ) {
        Cell = cell
    }

    /// Gets the cell the child deposits its value into.
    prop Cell VariableSymbol {
        get;
    }

    /// Gets or sets a value indicating whether the binding was read with `await` at least once. GS0559
    /// warns when it never is.
    prop WasAwaited bool
}
