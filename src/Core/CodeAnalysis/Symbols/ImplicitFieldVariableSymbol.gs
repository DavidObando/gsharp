// <copyright file="ImplicitFieldVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// A binder-internal pseudo-variable representing an instance field made
/// visible by name inside a class method body (Phase 3.B.3 sub-step 2b).
/// Resolving a bare identifier `X` to one of these triggers the binder
/// to emit a `BoundFieldAccessExpression` with the implicit
/// `this` receiver. Never appears in the bound tree itself.
class ImplicitFieldVariableSymbol : VariableSymbol {
    /// Initializes a new instance of the (cref:ImplicitFieldVariableSymbol) class.
    /// @param receiver The implicit `this` parameter the field is read through.
    /// @param structType The class that owns the field.
    /// @param field The underlying field.
    init(receiver ParameterSymbol, structType StructSymbol, field FieldSymbol) : base(
        field.Name,
        false,
        field.Type,
        nil
    ) {
        Receiver = receiver
        StructType = structType
        Field = field
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.LocalVariable

    /// Gets the implicit receiver parameter (`this`) for the enclosing method.
    prop Receiver ParameterSymbol {
        get;
    }

    /// Gets the class that owns the field.
    prop StructType StructSymbol {
        get;
    }

    /// Gets the field symbol.
    prop Field FieldSymbol {
        get;
    }
}
