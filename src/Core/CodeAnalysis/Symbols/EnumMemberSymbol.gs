// <copyright file="EnumMemberSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// Represents a member declared by a user-defined enum.
class EnumMemberSymbol : Symbol {
    /// Initializes a new instance of the (cref:EnumMemberSymbol) class.
    /// @param name The enum member name.
    /// @param enumType The owning enum type.
    /// @param value The auto-numbered integer value.
    init(name string, enumType EnumSymbol, value int32) : base(name) {
        EnumType = enumType
        Value = value
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.EnumMember

    /// Gets the owning enum type.
    prop EnumType EnumSymbol {
        get;
    }

    /// Gets the auto-numbered integer value.
    prop Value int32 {
        get;
    }
}
