// <copyright file="TypeSymbol.NullabilityFree.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System

/// ```xmldoc
/// <content>
/// ADR-0193 §3 (GSA0007): the audited, nullability-free conversion door.
/// </content>
/// ```
open partial class TypeSymbol : Symbol {
    shared {
        /// ADR-0193 §3: the named door for an audited, nullability-free
        /// conversion. It maps exactly as (cref:FromClrType) does; the
        /// required [`reason`](paramref) states why the type has no
        /// declaration nullability to lose. GSA0007 allows it anywhere, except
        /// when its argument is, within the same method, a signature accessor
        /// (`ReturnType`, `ParameterType`, `PropertyType`, …):
        /// those positions go through the funnel readers.
        /// @param clrType The CLR type to map.
        /// @param reason Why no declaration nullability applies.
        /// @returns The corresponding (cref:TypeSymbol).
        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(clrType Type?, reason NullabilityFreeReason) TypeSymbol {
            return FromClrType(clrType)
        }
    }
}
