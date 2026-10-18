// <copyright file="ParameterMetadataEmitter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

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

    /// Issue #4988: whether a signature needs the sequence-0 `Param` row. A
    /// MethodDef has one only when something is attached to its return
    /// position: a `[Nullable]` the plan calls for, tuple element names, a
    /// `ref readonly` marker, or a user `@return:` annotation. The decision
    /// is the same for a method with a body and one without, so every
    /// MethodDef-minting path asks here.
    /// @param plan The signature's nullability plan.
    /// @param returnType The declared return type, if any.
    /// @param returnRefKind The return's ref kind.
    /// @param owner The declaration whose `@return:` annotations apply, if any.
    /// @returns `true` when the row must be minted.
    func NeedsReturnParameter(
        plan MethodNullabilityPlan,
        returnType TypeSymbol?,
        returnRefKind RefKind,
        owner Symbol?
    ) bool {
        if plan.ReturnNeedsAttribute || returnRefKind == RefKind.RefReadOnly {
            return true
        }
        if returnType != nil && !TupleElementNamesBuilder.Build(returnType).IsDefaultOrEmpty {
            return true
        }
        if owner != nil && !owner.Attributes.IsDefaultOrEmpty {
            for attribute in owner.Attributes {
                if attribute.Target == AttributeTargetKind.Return {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #4988: adds the sequence-0 `Param` row that carries the return
    /// position's attributes. It has no name, and ECMA-335 II.22.33 requires it
    /// to precede the method's parameter rows, so a caller mints it before them.
    /// @param emitCtx The active emit context.
    /// @returns The return row's handle.
    func AddReturnParameter(emitCtx EmitContext) ParameterHandle -> emitCtx.Metadata.AddParameter(
        ParameterAttributes.None,
        default(StringHandle),
        sequenceNumber: 0
    )

    /// Issue #4988: mints a compiler-shaped signature's `Param` rows — the
    /// sequence-0 return row when (cref:NeedsReturnParameter) asks for one,
    /// then one row per parameter — together with the nullability plan they
    /// are stamped from once the MethodDef exists (see
    /// `CustomAttributeEncoder.EmitMethodNullability`). Accessors and
    /// synthesized members, which have no `FunctionSymbol` to run through
    /// `EmitFunction`, mint their rows here. Call it immediately before
    /// `AddMethodDefinition`, whose `parameterList` is (cref:SignatureRows.First).
    /// @param emitCtx The active emit context.
    /// @param returnType The signature's return type (`void` for none).
    /// @param returnRefKind The return's ref kind.
    /// @param parameters The signature's parameters, in order.
    /// @returns The rows and their plan.
    func AddSignatureRows(
        emitCtx EmitContext,
        returnType TypeSymbol,
        returnRefKind RefKind,
        parameters ImmutableArray[ParameterSymbol]
    ) SignatureRows {
        let first = MetadataTokens.ParameterHandle(emitCtx.Metadata.GetRowCount(TableIndex.Param) + 1)
        let plan = MethodNullabilityPlan.ForParameters(returnType, parameters)
        let returnRow ParameterHandle? = if NeedsReturnParameter(plan, returnType, returnRefKind, nil) {
            AddReturnParameter(emitCtx)
        } else {
            nil
        }
        let rows = ImmutableArray.CreateBuilder[ParameterHandle](parameters.Length)
        for var i = 0; i < parameters.Length; i++ {
            rows.Add(AddParameter(emitCtx, parameters[i], sequenceNumber: i + 1))
        }
        return SignatureRows(first, plan, returnRow, returnType, parameters, rows.MoveToImmutable())
    }
}

/// Issue #4988: a compiler-shaped signature's minted `Param` rows and the
/// nullability plan they are stamped from.
/// @param First The MethodDef's `parameterList` anchor.
/// @param Nullability The signature's plan.
/// @param ReturnRow The sequence-0 row, when the return position carries anything.
/// @param ReturnType The signature's return type.
/// @param Parameters The parameters, in order.
/// @param Rows Their rows, in the same order.
internal data struct SignatureRows(
    First ParameterHandle,
    Nullability MethodNullabilityPlan,
    ReturnRow ParameterHandle?,
    ReturnType TypeSymbol,
    Parameters ImmutableArray[ParameterSymbol],
    Rows ImmutableArray[ParameterHandle]
) : IEquatable[SignatureRows] { }
