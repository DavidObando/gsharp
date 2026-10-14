// <copyright file="ImplicitStaticPropertyVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// A binder-internal pseudo-variable representing a static property made
/// visible by name inside a method body of the enclosing type (ADR-0053 §5,
/// extended to instance methods so a class can use its shared properties
/// without the `TypeName.` prefix). Resolving a bare identifier
/// `X` to one of these triggers the binder to emit a
/// `BoundPropertyAccessExpression`/`BoundPropertyAssignmentExpression`
/// with a `null` receiver (static access). Never appears in the bound
/// tree itself.
class ImplicitStaticPropertyVariableSymbol : VariableSymbol {
    /// Initializes a new instance of the (cref:ImplicitStaticPropertyVariableSymbol) class.
    /// @param structType The class that owns the static property.
    /// @param property The underlying static property.
    init(structType StructSymbol, property PropertySymbol) : base(
        property.Name,
        !property.HasSetter,
        property.Type,
        nil
    ) {
        StructType = structType
        Property = property
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.LocalVariable

    /// Gets the class that owns the static property.
    prop StructType StructSymbol {
        get;
    }

    /// Gets the static property symbol.
    prop Property PropertySymbol {
        get;
    }
}
