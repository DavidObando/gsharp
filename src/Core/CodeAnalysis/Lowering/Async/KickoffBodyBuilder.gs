// <copyright file="KickoffBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection

/// The kind of a planned kickoff-stub operation.
enum KickoffOperationKind {
    DeclareStateMachineLocal,
    InitializeBuilder,
    CopyThis,
    CopyParameter,
    InitializeState,
    StartStateMachine,
    ReturnBuilderTask,
    ReturnVoid
}

/// Plans the kickoff stub for an async state machine.
/// @remarks The kickoff stub is the original async method after state-machine lowering:
/// it creates the state-machine local, initializes the builder and state fields,
/// copies parameters into hoisted fields, calls `builder.Start(ref sm)`,
/// and returns `builder.Task` for task-returning methods. This slice records
/// that canonical sequence without replacing the bound body yet.
shared class KickoffBodyBuilder {
    /// Builds the kickoff-body plan for one async state-machine method.
    /// @param kickoffMethod The original async method.
    /// @param fieldMap The state-machine field map.
    /// @returns The kickoff-body plan.
    func Build(kickoffMethod FunctionSymbol?, fieldMap AsyncStateMachineFieldMap?) KickoffBodyPlan {
        if kickoffMethod == nil {
            throw ArgumentNullException("kickoffMethod")
        }
        if fieldMap == nil {
            throw ArgumentNullException("fieldMap")
        }
        let parameterCopies = ImmutableArray.CreateBuilder[KickoffParameterCopy](kickoffMethod.EmittedParameters.Length)
        // ADR-0174 D7: the hidden context is a parameter like any other here —
        // the kickoff copies it into the state machine so the body can read it.
        for parameter in kickoffMethod.EmittedParameters {
            parameterCopies.Add(KickoffParameterCopy(parameter, fieldMap.GetParameterField(parameter)))
        }
        return KickoffBodyPlan(
            LocalVariableSymbol("<>sm", isReadOnly: false, fieldMap.StructType),
            StateMachineStates.NotStartedOrRunningState,
            fieldMap.StateField,
            fieldMap.BuilderField,
            fieldMap.ThisField,
            parameterCopies.ToImmutable(),
            Invariant.Required(
                fieldMap.StateMachine.BuilderInfo.CreateMethod,
                "a state machine is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, which requires Create",
                expression: "fieldMap.StateMachine.BuilderInfo.CreateMethod"
            ),
            Invariant.Required(
                fieldMap.StateMachine.BuilderInfo.StartMethod,
                "a state machine is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, which requires Start (MoveNext for an async iterator)",
                expression: "fieldMap.StateMachine.BuilderInfo.StartMethod"
            ),
            fieldMap.StateMachine.BuilderInfo.TaskProperty
        )
    }
}

/// Planned kickoff-stub operations for one async method.
class KickoffBodyPlan {
    /// Initializes a new instance of the (cref:KickoffBodyPlan) class.
    /// @param stateMachineLocal The local that will hold the state-machine instance.
    /// @param initialState The initial value assigned to `<>1__state`.
    /// @param stateField The synthesized state field.
    /// @param builderField The synthesized builder field.
    /// @param thisField The synthesized `this` field, or `null`
    /// when the kickoff method does not capture a receiver.
    /// @param parameterCopies Parameter-to-field copies for the kickoff stub.
    /// @param builderCreateMethod The builder `Create` method.
    /// @param builderStartMethod The builder `Start<TStateMachine>` method.
    /// @param builderTaskProperty The builder `Task` property, or `null` for `async void`.
    init(
        stateMachineLocal LocalVariableSymbol,
        initialState int32,
        stateField FieldSymbol,
        builderField FieldSymbol,
        thisField FieldSymbol?,
        parameterCopies ImmutableArray[KickoffParameterCopy],
        builderCreateMethod MethodInfo,
        builderStartMethod MethodInfo,
        builderTaskProperty PropertyInfo?
    ) {
        StateMachineLocal = stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal")
        InitialState = initialState
        StateField = stateField ?? throw ArgumentNullException("stateField")
        BuilderField = builderField ?? throw ArgumentNullException("builderField")
        ThisField = thisField
        ParameterCopies = if parameterCopies.IsDefault {
            ImmutableArray[KickoffParameterCopy].Empty
        } else {
            parameterCopies
        }
        BuilderCreateMethod = builderCreateMethod ?? throw ArgumentNullException("builderCreateMethod")
        BuilderStartMethod = builderStartMethod ?? throw ArgumentNullException("builderStartMethod")
        BuilderTaskProperty = builderTaskProperty
        Operations = BuildOperations()
    }

    /// Gets the local that will hold the state-machine instance.
    prop StateMachineLocal LocalVariableSymbol {
        get;
    }

    /// Gets the initial value assigned to `<>1__state`.
    prop InitialState int32 {
        get;
    }

    /// Gets the synthesized state field.
    prop StateField FieldSymbol {
        get;
    }

    /// Gets the synthesized builder field.
    prop BuilderField FieldSymbol {
        get;
    }

    /// Gets the synthesized `this` field, or `null` when the
    /// kickoff method does not capture a receiver.
    prop ThisField FieldSymbol? {
        get;
    }

    /// Gets parameter-to-field copies for the kickoff stub.
    prop ParameterCopies ImmutableArray[KickoffParameterCopy] {
        get;
    }

    /// Gets the builder `Create` method.
    prop BuilderCreateMethod MethodInfo {
        get;
    }

    /// Gets the builder `Start<TStateMachine>` method.
    prop BuilderStartMethod MethodInfo {
        get;
    }

    /// Gets the builder `Task` property, or `null` for `async void`.
    prop BuilderTaskProperty PropertyInfo? {
        get;
    }

    /// Gets the ordered kickoff-stub operations.
    prop Operations ImmutableArray[KickoffOperation] {
        get;
    }

    /// Gets a value indicating whether the kickoff stub returns `builder.Task`.
    prop ReturnsBuilderTask bool -> BuilderTaskProperty != nil

    private func BuildOperations() ImmutableArray[KickoffOperation] {
        let operations = ImmutableArray.CreateBuilder[KickoffOperation]()
        operations.Add(KickoffOperation.DeclareStateMachineLocal(StateMachineLocal))
        operations.Add(KickoffOperation.InitializeBuilder(StateMachineLocal, BuilderField, BuilderCreateMethod))
        if ThisField != nil {
            operations.Add(KickoffOperation.CopyThis(StateMachineLocal, ThisField!!))
        }
        for copy in ParameterCopies {
            operations.Add(KickoffOperation.CopyParameter(StateMachineLocal, copy.Parameter, copy.Field))
        }
        operations.Add(KickoffOperation.InitializeState(StateMachineLocal, StateField, InitialState))
        operations.Add(KickoffOperation.StartStateMachine(StateMachineLocal, BuilderField, BuilderStartMethod))
        operations.Add(
            if BuilderTaskProperty != nil {
                KickoffOperation.ReturnBuilderTask(StateMachineLocal, BuilderField, BuilderTaskProperty!!)
            } else {
                KickoffOperation.ReturnVoid()
            }
        )
        return operations.ToImmutable()
    }
}

/// One ordered operation in the planned kickoff stub.
class KickoffOperation {
    private init(
        kind KickoffOperationKind,
        stateMachineLocal LocalVariableSymbol? = nil,
        field FieldSymbol? = nil,
        parameter ParameterSymbol? = nil,
        initialState int32? = nil,
        method MethodInfo? = nil,
        property PropertyInfo? = nil
    ) {
        Kind = kind
        StateMachineLocal = stateMachineLocal
        Field = field
        Parameter = parameter
        InitialState = initialState
        Method = method
        Property = property
    }

    /// Gets the operation kind.
    prop Kind KickoffOperationKind {
        get;
    }

    /// Gets the state-machine local for operations that target it,
    /// or `null` for (cref:KickoffOperationKind.ReturnVoid), the one
    /// kind that does not.
    prop StateMachineLocal LocalVariableSymbol? {
        get;
    }

    /// Gets the state-machine field read or written by the operation,
    /// or `null` for the kinds that touch no field.
    prop Field FieldSymbol? {
        get;
    }

    /// Gets the kickoff parameter copied by the operation, or
    /// `null` for every kind other than
    /// (cref:KickoffOperationKind.CopyParameter).
    prop Parameter ParameterSymbol? {
        get;
    }

    /// Gets the initial state value written by the operation, or
    /// `null` for every kind other than
    /// (cref:KickoffOperationKind.InitializeState).
    prop InitialState int32? {
        get;
    }

    /// Gets the builder method called by the operation, or `null`
    /// for the kinds that call none.
    prop Method MethodInfo? {
        get;
    }

    /// Gets the builder property read by the operation, or `null`
    /// for every kind other than
    /// (cref:KickoffOperationKind.ReturnBuilderTask).
    prop Property PropertyInfo? {
        get;
    }

    shared {
        /// Creates a state-machine local declaration operation.
        /// @param stateMachineLocal The state-machine local.
        /// @returns The operation.
        func DeclareStateMachineLocal(stateMachineLocal LocalVariableSymbol) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.DeclareStateMachineLocal,
                stateMachineLocal: stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal")
            )
        }

        /// Creates a builder initialization operation.
        /// @param stateMachineLocal The state-machine local.
        /// @param builderField The builder field.
        /// @param createMethod The builder `Create` method.
        /// @returns The operation.
        func InitializeBuilder(
            stateMachineLocal LocalVariableSymbol,
            builderField FieldSymbol,
            createMethod MethodInfo
        ) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.InitializeBuilder,
                stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal"),
                builderField ?? throw ArgumentNullException("builderField"),
                method: createMethod ?? throw ArgumentNullException("createMethod")
            )
        }

        /// Creates a receiver copy operation.
        /// @param stateMachineLocal The state-machine local.
        /// @param thisField The synthesized `this` field.
        /// @returns The operation.
        func CopyThis(stateMachineLocal LocalVariableSymbol, thisField FieldSymbol) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.CopyThis,
                stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal"),
                thisField ?? throw ArgumentNullException("thisField")
            )
        }

        /// Creates a parameter copy operation.
        /// @param stateMachineLocal The state-machine local.
        /// @param parameter The kickoff parameter.
        /// @param parameterField The hoisted parameter field.
        /// @returns The operation.
        func CopyParameter(
            stateMachineLocal LocalVariableSymbol,
            parameter ParameterSymbol,
            parameterField FieldSymbol
        ) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.CopyParameter,
                stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal"),
                parameterField ?? throw ArgumentNullException("parameterField"),
                parameter ?? throw ArgumentNullException("parameter")
            )
        }

        /// Creates a state initialization operation.
        /// @param stateMachineLocal The state-machine local.
        /// @param stateField The state field.
        /// @param initialState The initial state value.
        /// @returns The operation.
        func InitializeState(
            stateMachineLocal LocalVariableSymbol,
            stateField FieldSymbol,
            initialState int32
        ) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.InitializeState,
                stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal"),
                stateField ?? throw ArgumentNullException("stateField"),
                initialState: initialState
            )
        }

        /// Creates a state-machine start operation.
        /// @param stateMachineLocal The state-machine local.
        /// @param builderField The builder field.
        /// @param startMethod The builder `Start` method.
        /// @returns The operation.
        func StartStateMachine(
            stateMachineLocal LocalVariableSymbol,
            builderField FieldSymbol,
            startMethod MethodInfo
        ) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.StartStateMachine,
                stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal"),
                builderField ?? throw ArgumentNullException("builderField"),
                method: startMethod ?? throw ArgumentNullException("startMethod")
            )
        }

        /// Creates a builder task return operation.
        /// @param stateMachineLocal The state-machine local.
        /// @param builderField The builder field.
        /// @param taskProperty The builder `Task` property.
        /// @returns The operation.
        func ReturnBuilderTask(
            stateMachineLocal LocalVariableSymbol,
            builderField FieldSymbol,
            taskProperty PropertyInfo
        ) KickoffOperation {
            return KickoffOperation(
                KickoffOperationKind.ReturnBuilderTask,
                stateMachineLocal ?? throw ArgumentNullException("stateMachineLocal"),
                builderField ?? throw ArgumentNullException("builderField"),
                property: taskProperty ?? throw ArgumentNullException("taskProperty")
            )
        }

        /// Creates a void return operation.
        /// @returns The operation.
        func ReturnVoid() KickoffOperation {
            return KickoffOperation(KickoffOperationKind.ReturnVoid)
        }
    }
}

/// Planned copy from a kickoff parameter into its hoisted state-machine field.
class KickoffParameterCopy {
    /// Initializes a new instance of the (cref:KickoffParameterCopy) class.
    /// @param parameter The kickoff parameter.
    /// @param field The state-machine field receiving the parameter value.
    init(parameter ParameterSymbol, field FieldSymbol) {
        Parameter = parameter ?? throw ArgumentNullException("parameter")
        Field = field ?? throw ArgumentNullException("field")
    }

    /// Gets the kickoff parameter.
    prop Parameter ParameterSymbol {
        get;
    }

    /// Gets the state-machine field receiving the parameter value.
    prop Field FieldSymbol {
        get;
    }
}
