// <copyright file="BoundAddressOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression representing the address-of operator `&expr`.
/// The operand must be an lvalue. The result type is `*T` where T is the operand's type.
class BoundAddressOfExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundAddressOfExpression) class.
    /// @param syntax The originating syntax.
    /// @param operand The lvalue operand whose address is being taken.
    convenience init(syntax SyntaxNode?, operand BoundExpression) {
        init(syntax, operand, false, false)
    }

    /// Initializes a new instance of the (cref:BoundAddressOfExpression) class.
    /// @param syntax The originating syntax.
    /// @param operand The lvalue operand whose address is being taken.
    /// @param unmanaged ADR-0122 / issue #1014: when `true` the result is an
    /// <em>unmanaged</em> raw pointer ((cref:PointerTypeSymbol),
    /// `T*`) — used inside an `unsafe` context. When
    /// `false` (the default) the result is a managed by-ref
    /// pointer ((cref:ByRefTypeSymbol), `T&`).
    /// @param isReadOnly Whether the reference permits only reads of its referent.
    init(syntax SyntaxNode?, operand BoundExpression, unmanaged bool, isReadOnly bool = false) : base(syntax) {
        Operand = operand
        IsUnmanaged = unmanaged
        IsReadOnly = isReadOnly || RefCapabilities.IsReadOnlyReference(operand)
        _type = if unmanaged {
            cast[TypeSymbol](PointerTypeSymbol.Get(operand.Type))
        } else {
            cast[TypeSymbol](ByRefTypeSymbol.Get(operand.Type))
        }
    }

    /// Gets a value indicating whether this address-of produces an unmanaged raw
    /// pointer (`T*`) rather than a managed by-ref (`T&`).
    /// ADR-0122 / issue #1014.
    prop IsUnmanaged bool {
        get;
    }

    /// Gets a value indicating whether the managed reference prohibits writes to its referent.
    prop IsReadOnly bool {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.AddressOfExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the lvalue operand whose address is being taken.
    prop Operand BoundExpression {
        get;
    }
}
