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
        let pointeeType = ExpressionBinder.AddressedLeafStorageType(operand, useEffectiveNullability: true)
        _type = if unmanaged {
            cast[TypeSymbol](PointerTypeSymbol.Get(pointeeType))
        } else {
            cast[TypeSymbol](ByRefTypeSymbol.Get(pointeeType))
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

    // Syntax anchoring also stamps immediate-index addresses; keep escape classification separate.
    internal var FixedBufferEscapeSyntax SyntaxNode?

    // Retains fixed-buffer syntax across direct indexing in case a later suspension spills the pointer.
    internal var FixedBufferSyntax SyntaxNode?

    // Rebuild the operand without losing address permissions or fixed-buffer escape provenance.
    internal func Update(operand BoundExpression) BoundAddressOfExpression -> if operand == Operand {
        this
    } else {
        BoundAddressOfExpression(Syntax, operand, IsUnmanaged, IsReadOnly){
            FixedBufferEscapeSyntax = this.FixedBufferEscapeSyntax,
            FixedBufferSyntax = this.FixedBufferSyntax
        }
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
