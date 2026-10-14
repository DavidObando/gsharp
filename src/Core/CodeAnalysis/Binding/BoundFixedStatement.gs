// <copyright file="BoundFixedStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System

/// ADR-0125 / issue #1026: the kind of managed buffer a `fixed` statement
/// pins, which selects the element-0 pointer-derivation pattern emitted.
enum FixedPinKind {
    Array,
    String,
    PinnableReference,
    FixedBuffer
}

/// ADR-0125 / issue #1026: a bound `fixed` (pinning) statement. Pins the
/// managed buffer (cref:PinnedSource) into the synthetic
/// (cref:PinnedVariable) (a CLR pinned local) for the duration of
/// (cref:Body), and binds the user-visible unmanaged pointer
/// (cref:PointerVariable) (`*T`) to the address of element 0.
/// Lowers in the emitter to the CLR pinned-local pattern, mirroring C#
/// `fixed (T* p = expr) { … }`; the pin is released (the pinned local is
/// nulled) on normal block exit.
class BoundFixedStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundFixedStatement) class.
    /// @param syntax The originating syntax.
    /// @param pinKind Whether the pinned source is an array, a string, or a span-like
    /// `GetPinnableReference` source.
    /// @param pinnedVariable The synthetic pinned local.
    /// @param pointerVariable The user-visible `*T` pointer local.
    /// @param pinnedSource The managed array/string source to pin.
    /// @param body The block over which the pin is held.
    /// @param sourceVariable For the (cref:FixedPinKind.PinnableReference) form only: a synthetic
    /// local holding the span-like source value, whose address feeds the
    /// `GetPinnableReference()` instance call. Null for the array/string forms.
    init(
        syntax SyntaxNode?,
        pinKind FixedPinKind,
        pinnedVariable VariableSymbol,
        pointerVariable VariableSymbol,
        pinnedSource BoundExpression,
        body BoundStatement,
        sourceVariable VariableSymbol? = nil
    ) : base(syntax) {
        PinKind = pinKind
        PinnedVariable = pinnedVariable ?? throw ArgumentNullException("pinnedVariable")
        PointerVariable = pointerVariable ?? throw ArgumentNullException("pointerVariable")
        PinnedSource = pinnedSource ?? throw ArgumentNullException("pinnedSource")
        Body = body ?? throw ArgumentNullException("body")
        SourceVariable = sourceVariable
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.FixedStatement

    /// Gets whether the pinned source is an array, a string, or a span-like `GetPinnableReference` source.
    prop PinKind FixedPinKind {
        get;
    }

    /// Gets the synthetic pinned local (a CLR `pinned` local).
    prop PinnedVariable VariableSymbol {
        get;
    }

    /// Gets the user-visible `*T` pointer local.
    prop PointerVariable VariableSymbol {
        get;
    }

    /// Gets the managed source to pin: the array/string/span-like value, or — for
    /// (cref:FixedPinKind.FixedBuffer) — the managed address-of
    /// `ref recv.name.FixedElementField` of the buffer's first element.
    prop PinnedSource BoundExpression {
        get;
    }

    /// Gets the synthetic local holding the span-like source value for the
    /// (cref:FixedPinKind.PinnableReference) form (whose address feeds the
    /// `GetPinnableReference()` instance call), or null for other forms.
    prop SourceVariable VariableSymbol? {
        get;
    }

    /// Gets the block over which the pin is held.
    prop Body BoundStatement {
        get;
    }
}
