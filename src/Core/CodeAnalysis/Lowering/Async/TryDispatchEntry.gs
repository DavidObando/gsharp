// <copyright file="TryDispatchEntry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis.Binding

/// One entry in a user try's internal state dispatch.
internal struct TryDispatchEntry {
    /// Initializes a new instance of the (cref:TryDispatchEntry) struct.
    /// @param state The await state number.
    /// @param target The dispatch target label.
    init(state int32, target BoundLabel) {
        State = state
        Target = target
    }

    /// Gets the await state number.
    prop State int32 {
        get;
    }

    /// Gets the dispatch target label.
    prop Target BoundLabel {
        get;
    }
}
