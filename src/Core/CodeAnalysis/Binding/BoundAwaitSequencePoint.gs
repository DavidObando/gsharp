// <copyright file="BoundAwaitSequencePoint.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Hidden sequence-point marker emitted around async await suspension points.
/// Emits a single `nop` opcode, giving a future PDB writer a definite IL
/// offset to anchor a hidden (0xfeefee) sequence point on.
class BoundAwaitSequencePoint : BoundStatement {
    /// Initializes a new instance of the (cref:BoundAwaitSequencePoint) class.
    /// @param syntax The originating syntax.
    /// @param kind Whether this is a yield point or a resume point.
    /// @param state The await state number for PDB round-trip.
    init(syntax SyntaxNode?, kind BoundNodeKind, state int32) : base(syntax) {
        _kind = kind
        State = state
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _kind BoundNodeKind

    override prop Kind BoundNodeKind -> _kind

    /// Gets the await state number.
    prop State int32 {
        get;
    }
}
