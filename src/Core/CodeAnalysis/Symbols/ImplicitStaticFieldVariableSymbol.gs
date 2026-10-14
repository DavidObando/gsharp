// <copyright file="ImplicitStaticFieldVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// A binder-internal pseudo-variable representing a static field made
/// visible by name inside a shared method body (Issue #261 / ADR-0053).
/// Resolving a bare identifier `x` to one of these triggers the binder
/// to emit a `BoundFieldAccessExpression` with a `null` receiver
/// (static access). Never appears in the bound tree itself.
class ImplicitStaticFieldVariableSymbol : VariableSymbol {
    /// Initializes a new instance of the (cref:ImplicitStaticFieldVariableSymbol) class.
    /// @param structType The class that owns the static field.
    /// @param field The underlying static field.
    init(structType StructSymbol, field FieldSymbol) : base(field.Name, field.IsReadOnly, field.Type, nil) {
        StructType = structType
        Field = field
    }

    /// Initializes a new instance of the (cref:ImplicitStaticFieldVariableSymbol)
    /// class owned by an interface (ADR-0089 / issue #1030). Interface static
    /// fields have no (cref:StructSymbol) owner; (cref:StructType)
    /// stays `null` and the emitter resolves the field by symbol identity.
    /// @param interfaceType The interface that owns the static field.
    /// @param field The underlying static field.
    init(interfaceType InterfaceSymbol, field FieldSymbol) : base(field.Name, field.IsReadOnly, field.Type, nil) {
        InterfaceType = interfaceType
        Field = field
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.LocalVariable

    /// Gets the class that owns the static field, or `null` for an interface owner.
    prop StructType StructSymbol? {
        get;
    }

    /// Gets the interface that owns the static field (issue #1030), or `null` for a struct/class owner.
    prop InterfaceType InterfaceSymbol? {
        get;
    }

    /// Gets the display name of the owning type (struct/class or interface).
    prop OwnerName string -> StructType?.Name ?? InterfaceType?.Name ?? string.Empty

    /// Gets the static field symbol.
    prop Field FieldSymbol {
        get;
    }
}
