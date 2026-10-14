// <copyright file="PinnedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System

/// ADR-0125 / issue #1026: a synthetic marker type for the <em>pinned</em> CLR
/// local introduced by a `fixed` statement. It wraps the local's real
/// storage type ((cref:UnderlyingType)) — either the managed array type
/// `T[]` (array-pin form) or a managed by-ref `T&`
/// ((cref:ByRefTypeSymbol), string-pin form) — and signals the emitter
/// to set the `pinned` flag on that local's signature
/// (`.locals init ([n] … pinned)`) so the GC cannot relocate the buffer.
/// @remarks This wrapper is attached only to a synthetic local that the emitter touches
/// directly (via its IL slot); it never flows through expression binding, so no
/// general `is`/equality checks elsewhere observe it. The only consumer is
/// `ReflectionMetadataEmitter.EncodeLocalVariableType`.
class PinnedTypeSymbol : TypeSymbol {
    /// Initializes a new instance of the (cref:PinnedTypeSymbol) class.
    /// @param underlyingType The pinned local's underlying storage type.
    init(underlyingType TypeSymbol) : base(
        "pinned ${underlyingType?.Name}",
        (underlyingType ?? throw ArgumentNullException("underlyingType")).ClrType
    ) {
        UnderlyingType = underlyingType
    }

    /// Gets the pinned local's underlying storage type (`T[]` for the
    /// array-pin form, or a (cref:ByRefTypeSymbol) for the string-pin form).
    prop UnderlyingType TypeSymbol {
        get;
    }
}
