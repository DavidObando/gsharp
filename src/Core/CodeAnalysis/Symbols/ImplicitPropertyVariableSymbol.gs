// <copyright file="ImplicitPropertyVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// A binder-internal pseudo-variable representing an instance property made
/// visible by name inside a class method body.
/// Resolving a bare identifier `Name` to one of these triggers the binder
/// to emit a `BoundPropertyAccessExpression` with the implicit
/// `this` receiver. Never appears in the bound tree itself.
class ImplicitPropertyVariableSymbol : VariableSymbol {
    /// Initializes a new instance of the (cref:ImplicitPropertyVariableSymbol) class.
    /// @param receiver The implicit `this` parameter the property is accessed through.
    /// @param structType The class that owns the property.
    /// @param property The underlying property.
    init(receiver ParameterSymbol, structType StructSymbol, property PropertySymbol) : base(
        property.Name,
        !property.HasSetter,
        property.Type,
        nil
    ) {
        Receiver = receiver
        StructType = structType
        Property = property
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.LocalVariable

    /// Gets the implicit receiver parameter (`this`) for the enclosing method.
    prop Receiver ParameterSymbol {
        get;
    }

    /// Gets the class that owns the property.
    prop StructType StructSymbol {
        get;
    }

    /// Gets the property symbol.
    prop Property PropertySymbol {
        get;
    }
}
