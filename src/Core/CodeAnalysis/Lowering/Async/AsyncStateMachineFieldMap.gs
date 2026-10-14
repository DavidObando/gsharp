// <copyright file="AsyncStateMachineFieldMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis
import System.Collections.Immutable

/// Maps user variables and synthesized control slots to the fields on a
/// materialized async state-machine aggregate.
/// @remarks The state-machine rewriter needs to replace local/parameter reads with
/// field reads against the generated `this` receiver. This helper is the
/// bridge between the pure (cref:SynthesizedStateMachineType) model and
/// the existing bound-tree nodes, which are keyed by (cref:StructSymbol).
class AsyncStateMachineFieldMap {
    private let parameterFields Dictionary[ParameterSymbol, FieldSymbol] = Dictionary[ParameterSymbol, FieldSymbol]()
    private let localFields Dictionary[VariableSymbol, FieldSymbol] = Dictionary[VariableSymbol, FieldSymbol]()

    private init(stateMachine SynthesizedStateMachineType, structType StructSymbol) {
        StateMachine = stateMachine
        StructType = structType
    }

    /// Gets the synthesized state-machine model.
    prop StateMachine SynthesizedStateMachineType {
        get;
    }

    /// Gets the materialized aggregate symbol backing field accesses.
    prop StructType StructSymbol {
        get;
    }

    /// Gets the hoisted state field.
    prop StateField FieldSymbol -> Invariant.Required(
        StateMachine.StateField,
        "a field map is only created from a state machine AsyncStateMachineTypeBuilder has already populated, and it always adds the state field",
        expression: "StateMachine.StateField"
    )

    /// Gets the hoisted async method builder field.
    prop BuilderField FieldSymbol -> Invariant.Required(
        StateMachine.BuilderField,
        "a field map is only created from a state machine AsyncStateMachineTypeBuilder has already populated, and it always adds the builder field",
        expression: "StateMachine.BuilderField"
    )

    /// Gets the hoisted `this` field, or `null` when the
    /// kickoff method does not capture a receiver.
    prop ThisField FieldSymbol? -> StateMachine.ThisField

    /// Gets the hoisted field corresponding to a kickoff parameter.
    /// @param parameter The kickoff parameter.
    /// @returns The corresponding state-machine field.
    func GetParameterField(parameter ParameterSymbol?) FieldSymbol {
        if parameter == nil {
            throw ArgumentNullException("parameter")
        }
        return if parameterFields.TryGetValue(parameter, out var field) {
            field
        } else {
            throw KeyNotFoundException(
                "Parameter '${parameter.Name}' is not hoisted into state machine '${StateMachine.Name}'."
            )
            default(FieldSymbol)
        }
    }

    /// Gets the hoisted field corresponding to a user local.
    /// @param local The user local.
    /// @returns The corresponding state-machine field.
    func GetLocalField(local VariableSymbol?) FieldSymbol {
        if local == nil {
            throw ArgumentNullException("local")
        }
        return if localFields.TryGetValue(local, out var field) {
            field
        } else {
            throw KeyNotFoundException(
                "Local '${local.Name}' is not hoisted into state machine '${StateMachine.Name}'."
            )
            default(FieldSymbol)
        }
    }

    /// Creates a field read against a state-machine receiver expression.
    /// @param receiver The state-machine receiver expression.
    /// @param field The field to read.
    /// @returns A bound field-access expression using the materialized aggregate.
    func Read(receiver BoundExpression?, field FieldSymbol?) BoundFieldAccessExpression {
        if receiver == nil {
            throw ArgumentNullException("receiver")
        }
        if field == nil {
            throw ArgumentNullException("field")
        }
        return BoundFieldAccessExpression(nil, receiver, StructType, field)
    }

    /// Creates a field assignment against a state-machine receiver variable.
    /// @param receiver The state-machine receiver variable.
    /// @param field The field to assign.
    /// @param value The value being stored.
    /// @returns A bound field-assignment expression using the materialized aggregate.
    func Write(receiver VariableSymbol?, field FieldSymbol?, value BoundExpression?) BoundFieldAssignmentExpression {
        if receiver == nil {
            throw ArgumentNullException("receiver")
        }
        if field == nil {
            throw ArgumentNullException("field")
        }
        if value == nil {
            throw ArgumentNullException("value")
        }
        return BoundFieldAssignmentExpression(nil, receiver, StructType, field, value)
    }

    /// Attempts to find the hoisted field for a variable (local, parameter,
    /// or the kickoff method's implicit `this`). Returns `true` if
    /// the variable is hoisted.
    /// @remarks Issue #2331: `this` is hoisted into (cref:ThisField)
    /// unconditionally for every instance-method state machine (see
    /// (cref:AsyncStateMachineTypeBuilder)), but it is intentionally
    /// kept out of (cref:parameterFields) because it is not an
    /// ordinary kickoff parameter. Every caller that resolves a hoisted slot
    /// for a captured variable — including the emitter's closure-construction
    /// site (`EmitCapturedVariableLoad`) — must special-case it here so
    /// there is a single source of truth for "is this variable hoisted",
    /// rather than duplicating the `this` check at each call site.
    /// @param variable The variable to look up.
    /// @param field The hoisted field, if found.
    /// @returns `true` if the variable is hoisted; otherwise `false`.
    func TryGetHoistedField(variable VariableSymbol, @NotNullWhen(true) out field FieldSymbol?) bool {
        if variable is ParameterSymbol ps {
            if ThisField != nil && object.ReferenceEquals(ps, StateMachine.KickoffMethod.ThisParameter) {
                field = ThisField
                return true
            }
            return parameterFields.TryGetValue(ps, out field)
        }
        return localFields.TryGetValue(variable, out field)
    }

    shared {
        /// Creates a field map for [`stateMachine`](paramref) using the same
        /// capture-walker ordering that populated the state-machine fields.
        /// @param stateMachine The synthesized state-machine type.
        /// @param loweredBody The lowered async body used to compute hoisted locals.
        /// @returns A field map whose (cref:StructType) is ready for bound field access nodes.
        func Create(stateMachine SynthesizedStateMachineType?, loweredBody BoundStatement?) AsyncStateMachineFieldMap {
            if stateMachine == nil {
                throw ArgumentNullException("stateMachine")
            }
            if loweredBody == nil {
                throw ArgumentNullException("loweredBody")
            }
            let structType = stateMachine.MaterializeAsStructSymbol()
            let map_ = AsyncStateMachineFieldMap(stateMachine, structType)
            let hoist = AsyncCaptureWalker.Analyze(loweredBody, stateMachine.KickoffMethod.EmittedParameters)
            let fields = stateMachine.Fields
            var fieldIndex = 2
            if stateMachine.ThisField != nil {
                fieldIndex++
            }
            for parameter in hoist.Parameters {
                map_.parameterFields.Add(parameter, RequireField(fields, fieldIndex, parameter.Name))
                fieldIndex++
            }
            for local in hoist.Locals {
                map_.localFields.Add(local, RequireField(fields, fieldIndex, nil))
                fieldIndex++
            }
            for spillLocal in hoist.SpillLocals {
                map_.localFields.Add(spillLocal, RequireField(fields, fieldIndex, spillLocal.Name))
                fieldIndex++
            }
            return map_
        }

        private func RequireField(fields ImmutableArray[FieldSymbol], index int32, expectedName string?) FieldSymbol {
            if index < 0 || index >= fields.Length {
                throw InvalidOperationException(
                    "Synthesized state-machine field layout does not match the capture walker output."
                )
            }
            let field = fields[index]
            if expectedName != nil && field.Name != expectedName {
                throw InvalidOperationException(
                    "Synthesized state-machine field layout does not match the capture walker output."
                )
            }
            return field
        }
    }
}
