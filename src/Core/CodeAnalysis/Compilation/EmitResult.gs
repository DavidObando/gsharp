// <copyright file="EmitResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Compilation

import GSharp.Core.CodeAnalysis
import System.Collections.Immutable

/// Represents the result of a compilation emit operation.
open class EmitResult {
    /// Initializes a new instance of the (cref:EmitResult) class.
    /// @param success Success state.
    /// @param diagnostics Diagnostics bag.
    init(success bool, diagnostics ImmutableArray[Diagnostic]) {
        Success = success
        Diagnostics = diagnostics
    }

    /// Gets a value indicating whether the compilation successfully produced an executable.
    /// If false then the diagnostics should include at least one error diagnostic
    /// indicating the cause of the failure.
    prop Success bool {
        get;
    }

    /// Gets a list of all the diagnostics associated with compilations. This include parse errors,
    /// declaration errors,
    /// compilation errors, and emitting errors.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }
}
