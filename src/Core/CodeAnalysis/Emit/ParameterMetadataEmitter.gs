// <copyright file="ParameterMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Reflection
import System.Reflection.Metadata

/// Emits metadata shared by user-declared method, constructor and property parameters.
internal shared class ParameterMetadataEmitter {
    /// Adds a parameter row, including ref-kind and optional-default metadata.
    /// @param emitCtx The active emit context.
    /// @param parameter The source parameter.
    /// @param sequenceNumber The one-based parameter sequence number.
    /// @param attributes Additional attributes required by the caller.
    /// @param fallbackName The metadata name used when the source parameter is unnamed.
    /// @returns The emitted parameter handle.
    func AddParameter(
        emitCtx EmitContext,
        parameter ParameterSymbol,
        sequenceNumber int32,
        attributes ParameterAttributes = ParameterAttributes.None,
        fallbackName string = ""
    ) ParameterHandle {
        var attributes = attributes
        if parameter.RefKind == RefKind.Out {
            attributes |= ParameterAttributes.Out
        } else if parameter.RefKind == RefKind.In {
            attributes |= ParameterAttributes.In
        }
        if parameter.HasExplicitDefaultValue {
            attributes |= ParameterAttributes.Optional | ParameterAttributes.HasDefault
        }
        let handle = emitCtx.Metadata.AddParameter(
            attributes,
            emitCtx.Metadata.GetOrAddString(parameter.Name ?? fallbackName),
            sequenceNumber
        )
        if parameter.HasExplicitDefaultValue {
            emitCtx.Metadata.AddConstant(handle, parameter.ExplicitDefaultValue)
        }
        return handle
    }
}
