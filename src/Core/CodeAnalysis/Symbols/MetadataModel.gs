// <copyright file="MetadataModel.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Threading

/// The model that the compiler uses for imported entities (ADR-0209 section 10).
internal enum MetadataModelMode {
    /// Reflection over a `MetadataLoadContext`. This is the default.
    Mlc,

    /// The handle-backed model.
    /// Until a consumer reads it, the reference resolver builds the set and uses reflection for every answer.
    Handles,

    /// Both models. The resolver asks both the same question and counts each different answer.
    Compare
}

/// Selects the (cref:MetadataModelMode) from the `GSHARP_METADATA_MODEL` environment variable.
internal shared class MetadataModel {
    /// The name of the environment variable.
    internal let VariableName string = "GSHARP_METADATA_MODEL"

    private let overridden AsyncLocal[MetadataModelMode?] = AsyncLocal[MetadataModelMode?]()

    /// Gets the mode in force: an override of the current async flow, else the environment variable.
    internal prop Current MetadataModelMode -> if overridden.Value is {} mode {
        mode
    } else {
        Parse(Environment.GetEnvironmentVariable(VariableName))
    }

    /// Reads a mode name. The names are `mlc`, `handles` and `compare`, in any case.
    /// @param value The value of the variable.
    /// @returns The named mode. An absent, empty or unknown value gives the default, (cref:MetadataModelMode.Mlc).
    internal func Parse(value string?) MetadataModelMode {
        if value is not{} text {
            return MetadataModelMode.Mlc
        }
        if string.Equals(text.Trim(), "handles", StringComparison.OrdinalIgnoreCase) {
            return MetadataModelMode.Handles
        }
        if string.Equals(text.Trim(), "compare", StringComparison.OrdinalIgnoreCase) {
            return MetadataModelMode.Compare
        }
        return MetadataModelMode.Mlc
    }

    /// Forces a mode for the current async flow until the result is disposed. Tests use it instead of the variable.
    internal func Override(mode MetadataModelMode) IDisposable {
        let previous = overridden.Value
        overridden.Value = mode
        return MetadataModelOverride(() -> overridden.Value = previous)
    }
}

/// Ends a mode override when disposed.
internal class MetadataModelOverride : IDisposable {
    private let restore Action

    internal init(restore Action) {
        this.restore = restore
    }

    func Dispose() {
        restore()
    }
}
