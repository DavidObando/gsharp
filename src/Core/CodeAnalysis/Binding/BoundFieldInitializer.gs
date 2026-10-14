// <copyright file="BoundFieldInitializer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System

/// A single `FieldName: value` initializer inside a struct/class composite
/// literal. The targeted member is either a (cref:FieldSymbol) (a
/// `var` member) or, since issue #1211, a settable
/// (cref:PropertySymbol) (a `prop` auto-property with a
/// `set`/`init` accessor).
data class BoundFieldInitializer : IEquatable[BoundFieldInitializer] {
    init(field FieldSymbol, value BoundExpression, fieldDeclaringType StructSymbol? = nil) {
        Field = field
        Value = value
        FieldDeclaringType = fieldDeclaringType
    }

    /// Initializes a new instance of the (cref:BoundFieldInitializer)
    /// class targeting a settable property (issue #1211): an auto-property with
    /// a `set` or `init` accessor. The emitter lowers this to a call
    /// to the property's setter/init accessor instead of a `stfld`.
    /// @param property The targeted property.
    /// @param value The value to assign.
    init(property PropertySymbol, value BoundExpression) {
        Property = property
        Value = value
    }

    /// Gets the targeted field, or `null` when this initializer targets a property.
    prop Field FieldSymbol? {
        get;
    }

    /// Gets the inherited type that declares (cref:Field), or `null` for a direct field or property.
    prop FieldDeclaringType StructSymbol? {
        get;
    }

    /// Gets the targeted property, or `null` when this initializer targets a field.
    prop Property PropertySymbol? {
        get;
    }

    prop Value BoundExpression {
        get;
        init;
    }

    /// Gets a value indicating whether this entry was copied from a declaration rather than authored at the
    /// literal site.
    prop IsDeclarationInitializer bool {
        get;
        init;
    }

    // Field and Property are an either-or pair: every constructor sets exactly
    // one, so a null Field implies a non-null Property.
    /// Gets the name of the targeted member (field or property).
    prop MemberName string -> if Field != nil {
        Field!!.Name
    } else {
        Property!!.Name
    }

    // Either-or, as for MemberName above.
    /// Gets the declared type of the targeted member (field or property).
    prop MemberType TypeSymbol -> if Field != nil {
        Field!!.Type
    } else {
        Property!!.Type
    }
}
