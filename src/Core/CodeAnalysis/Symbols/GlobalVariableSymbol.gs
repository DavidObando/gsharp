// <copyright file="GlobalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax

/// Represents a global variable symbol in the language.
class GlobalVariableSymbol : VariableSymbol {
    /// Initializes a new instance of the (cref:GlobalVariableSymbol) class.
    /// @param name The variable name.
    /// @param isReadOnly Whether it's read-only or not.
    /// @param type The type of the variable.
    /// @param accessibility The CLR visibility level (defaults to (cref:Accessibility.Public)).
    /// @param declaringSyntax The originating declaration syntax (may be `null` for
    /// synthesised globals such as host-package bootstrap state). Used by the
    /// PDB emitter to anchor field-declaration locations per ADR-0027 §7.7a.
    init(
        name string,
        isReadOnly bool,
        type TypeSymbol,
        accessibility Accessibility = Accessibility.Public,
        declaringSyntax SyntaxNode? = nil
    ) : base(name, isReadOnly, type, declaringSyntax) {
        Accessibility = accessibility
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.GlobalVariable

    /// Gets the CLR visibility level for this global variable.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets a value indicating whether this global is a compile-time constant.
    /// Reads are inlined from (cref:ConstantValue). ECMA constants emit
    /// as literal fields; decimal uses initialized static read-only storage.
    prop IsConst bool {
        get;
        private set;
    }

    /// Gets the compile-time value for an (cref:IsConst) global.
    prop ConstantValue object? {
        get;
        private set;
    }

    /// Marks this global as a compile-time constant and records its value.
    /// @param value The compile-time constant value.
    func SetConstantValue(value object?) {
        IsConst = true
        ConstantValue = value
    }
}
