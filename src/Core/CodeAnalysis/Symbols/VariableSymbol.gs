// <copyright file="VariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Represents a variable symbol in the language.
abstract class VariableSymbol : Symbol {
    /// Initializes a new instance of the (cref:VariableSymbol) class.
    /// @param name The variable's name.
    /// @param isReadOnly Whether it's read-only or not.
    /// @param type The variable's type.
    /// @param declaringSyntax The originating declaration syntax (may be `null` for
    /// compiler-synthesised variables — async/iterator state-machine slots,
    /// lowering temporaries, etc.). Used by the Portable PDB emitter to map
    /// IL local slots back to source for stepping and locals display per
    /// ADR-0027 §7.7a.
    init(name string, isReadOnly bool, type TypeSymbol, declaringSyntax SyntaxNode? = nil) : base(name) {
        IsReadOnly = isReadOnly
        Type = type
        DeclaringSyntax = declaringSyntax
    }

    /// Gets a value indicating whether it's read-only or not.
    prop IsReadOnly bool {
        get;
    }

    /// Gets the variable's type.
    prop Type TypeSymbol {
        get;
    }

    /// Gets the originating declaration syntax for this variable, or
    /// `null` when the variable is compiler-synthesised and
    /// has no source-level declaration. Consumed by the Portable PDB emitter
    /// to anchor `LocalVariable` rows and (for hoisted async/iterator
    /// state-machine locals) the hoisted-local-scope `CustomDebugInformation`.
    prop DeclaringSyntax SyntaxNode? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if DeclaringSyntax is {} declaration {
        ImmutableArray.Create(declaration)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Gets or sets a value indicating whether this read-only variable's
    /// initializer was proven non-null from its bound expression.
    internal prop HasDefinitelyNonNullValue bool

    /// Gets or sets callable parameter names captured from a function literal
    /// or function-pointer initializer. Empty when the variable's callable
    /// shape carries types only.
    internal prop CallableParameterNames ImmutableArray[string]
}
