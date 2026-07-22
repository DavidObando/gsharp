// <copyright file="ParameterMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using System.Reflection.Metadata;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>Emits metadata shared by user-declared method and constructor parameters.</summary>
internal static class ParameterMetadataEmitter
{
    /// <summary>Adds a parameter row, including ref-kind and optional-default metadata.</summary>
    /// <param name="emitCtx">The active emit context.</param>
    /// <param name="parameter">The source parameter.</param>
    /// <param name="sequenceNumber">The one-based parameter sequence number.</param>
    /// <param name="attributes">Additional attributes required by the caller.</param>
    /// <param name="fallbackName">The metadata name used when the source parameter is unnamed.</param>
    /// <returns>The emitted parameter handle.</returns>
    public static ParameterHandle AddParameter(
        EmitContext emitCtx,
        ParameterSymbol parameter,
        int sequenceNumber,
        ParameterAttributes attributes = ParameterAttributes.None,
        string fallbackName = "")
    {
        if (parameter.RefKind == RefKind.Out)
        {
            attributes |= ParameterAttributes.Out;
        }
        else if (parameter.RefKind == RefKind.In)
        {
            attributes |= ParameterAttributes.In;
        }

        if (parameter.HasExplicitDefaultValue)
        {
            attributes |= ParameterAttributes.Optional | ParameterAttributes.HasDefault;
        }

        var handle = emitCtx.Metadata.AddParameter(
            attributes,
            emitCtx.Metadata.GetOrAddString(parameter.Name ?? fallbackName),
            sequenceNumber);

        if (parameter.HasExplicitDefaultValue)
        {
            emitCtx.Metadata.AddConstant(handle, parameter.ExplicitDefaultValue);
        }

        return handle;
    }
}
