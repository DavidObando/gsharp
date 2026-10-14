// <copyright file="ManagedReferenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

/// An address intrinsic, not a readonly operator on arbitrary values.
class ManagedReferenceExpression : GExpression {
    /// Initializes a new instance of the (cref:ManagedReferenceExpression) class.
    /// @param location The addressable location to retain.
    /// @param isReadOnly Whether the retained location is readonly.
    init(location GExpression, isReadOnly bool = false) {
        Location = location
        IsReadOnly = isReadOnly
    }

    /// Gets the addressable location expression.
    prop Location GExpression {
        get;
    }

    /// Gets a value indicating whether the retained location is readonly.
    prop IsReadOnly bool {
        get;
    }
}
