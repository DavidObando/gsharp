#nullable disable

// <copyright file="KickoffBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// The kind of a planned kickoff-stub operation.
/// </summary>
public enum KickoffOperationKind
{
    /// <summary>Declare the state-machine local.</summary>
    DeclareStateMachineLocal,

    /// <summary>Initialize the builder field by calling <c>Create</c>.</summary>
    InitializeBuilder,

    /// <summary>Copy the kickoff receiver into the synthesized <c>this</c> field.</summary>
    CopyThis,

    /// <summary>Copy a kickoff parameter into its hoisted state-machine field.</summary>
    CopyParameter,

    /// <summary>Initialize the state field.</summary>
    InitializeState,

    /// <summary>Call <c>builder.Start(ref sm)</c>.</summary>
    StartStateMachine,

    /// <summary>Return <c>builder.Task</c>.</summary>
    ReturnBuilderTask,

    /// <summary>Return without a value for <c>async void</c>.</summary>
    ReturnVoid,
}

/// <summary>
/// Plans the kickoff stub for an async state machine.
/// </summary>
/// <remarks>
/// The kickoff stub is the original async method after state-machine lowering:
/// it creates the state-machine local, initializes the builder and state fields,
/// copies parameters into hoisted fields, calls <c>builder.Start(ref sm)</c>,
/// and returns <c>builder.Task</c> for task-returning methods. This slice records
/// that canonical sequence without replacing the bound body yet.
/// </remarks>
public static class KickoffBodyBuilder
{
    /// <summary>
    /// Builds the kickoff-body plan for one async state-machine method.
    /// </summary>
    /// <param name="kickoffMethod">The original async method.</param>
    /// <param name="fieldMap">The state-machine field map.</param>
    /// <returns>The kickoff-body plan.</returns>
    public static KickoffBodyPlan Build(FunctionSymbol kickoffMethod, AsyncStateMachineFieldMap fieldMap)
    {
        if (kickoffMethod == null)
        {
            throw new ArgumentNullException(nameof(kickoffMethod));
        }

        if (fieldMap == null)
        {
            throw new ArgumentNullException(nameof(fieldMap));
        }

        var parameterCopies = ImmutableArray.CreateBuilder<KickoffParameterCopy>(kickoffMethod.Parameters.Length);
        foreach (var parameter in kickoffMethod.Parameters)
        {
            parameterCopies.Add(new KickoffParameterCopy(parameter, fieldMap.GetParameterField(parameter)));
        }

        return new KickoffBodyPlan(
            new LocalVariableSymbol("<>sm", isReadOnly: false, fieldMap.StructType),
            StateMachineStates.NotStartedOrRunningState,
            fieldMap.StateField,
            fieldMap.BuilderField,
            fieldMap.ThisField,
            parameterCopies.ToImmutable(),
            fieldMap.StateMachine.BuilderInfo.CreateMethod,
            fieldMap.StateMachine.BuilderInfo.StartMethod,
            fieldMap.StateMachine.BuilderInfo.TaskProperty);
    }
}

/// <summary>
/// Planned kickoff-stub operations for one async method.
/// </summary>
public sealed class KickoffBodyPlan
{
    /// <summary>Initializes a new instance of the <see cref="KickoffBodyPlan"/> class.</summary>
    /// <param name="stateMachineLocal">The local that will hold the state-machine instance.</param>
    /// <param name="initialState">The initial value assigned to <c>&lt;&gt;1__state</c>.</param>
    /// <param name="stateField">The synthesized state field.</param>
    /// <param name="builderField">The synthesized builder field.</param>
    /// <param name="thisField">The optional synthesized <c>this</c> field.</param>
    /// <param name="parameterCopies">Parameter-to-field copies for the kickoff stub.</param>
    /// <param name="builderCreateMethod">The builder <c>Create</c> method.</param>
    /// <param name="builderStartMethod">The builder <c>Start&lt;TStateMachine&gt;</c> method.</param>
    /// <param name="builderTaskProperty">The builder <c>Task</c> property, or <see langword="null"/> for <c>async void</c>.</param>
    public KickoffBodyPlan(
        LocalVariableSymbol stateMachineLocal,
        int initialState,
        FieldSymbol stateField,
        FieldSymbol builderField,
        FieldSymbol thisField,
        ImmutableArray<KickoffParameterCopy> parameterCopies,
        MethodInfo builderCreateMethod,
        MethodInfo builderStartMethod,
        PropertyInfo builderTaskProperty)
    {
        StateMachineLocal = stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal));
        InitialState = initialState;
        StateField = stateField ?? throw new ArgumentNullException(nameof(stateField));
        BuilderField = builderField ?? throw new ArgumentNullException(nameof(builderField));
        ThisField = thisField;
        ParameterCopies = parameterCopies.IsDefault
            ? ImmutableArray<KickoffParameterCopy>.Empty
            : parameterCopies;
        BuilderCreateMethod = builderCreateMethod ?? throw new ArgumentNullException(nameof(builderCreateMethod));
        BuilderStartMethod = builderStartMethod ?? throw new ArgumentNullException(nameof(builderStartMethod));
        BuilderTaskProperty = builderTaskProperty;
        Operations = BuildOperations();
    }

    /// <summary>Gets the local that will hold the state-machine instance.</summary>
    public LocalVariableSymbol StateMachineLocal { get; }

    /// <summary>Gets the initial value assigned to <c>&lt;&gt;1__state</c>.</summary>
    public int InitialState { get; }

    /// <summary>Gets the synthesized state field.</summary>
    public FieldSymbol StateField { get; }

    /// <summary>Gets the synthesized builder field.</summary>
    public FieldSymbol BuilderField { get; }

    /// <summary>Gets the optional synthesized <c>this</c> field.</summary>
    public FieldSymbol ThisField { get; }

    /// <summary>Gets parameter-to-field copies for the kickoff stub.</summary>
    public ImmutableArray<KickoffParameterCopy> ParameterCopies { get; }

    /// <summary>Gets the builder <c>Create</c> method.</summary>
    public MethodInfo BuilderCreateMethod { get; }

    /// <summary>Gets the builder <c>Start&lt;TStateMachine&gt;</c> method.</summary>
    public MethodInfo BuilderStartMethod { get; }

    /// <summary>Gets the builder <c>Task</c> property, or <see langword="null"/> for <c>async void</c>.</summary>
    public PropertyInfo BuilderTaskProperty { get; }

    /// <summary>Gets the ordered kickoff-stub operations.</summary>
    public ImmutableArray<KickoffOperation> Operations { get; }

    /// <summary>Gets a value indicating whether the kickoff stub returns <c>builder.Task</c>.</summary>
    public bool ReturnsBuilderTask => BuilderTaskProperty != null;

    private ImmutableArray<KickoffOperation> BuildOperations()
    {
        var operations = ImmutableArray.CreateBuilder<KickoffOperation>();
        operations.Add(KickoffOperation.DeclareStateMachineLocal(StateMachineLocal));
        operations.Add(KickoffOperation.InitializeBuilder(StateMachineLocal, BuilderField, BuilderCreateMethod));

        if (ThisField != null)
        {
            operations.Add(KickoffOperation.CopyThis(StateMachineLocal, ThisField));
        }

        foreach (var copy in ParameterCopies)
        {
            operations.Add(KickoffOperation.CopyParameter(StateMachineLocal, copy.Parameter, copy.Field));
        }

        operations.Add(KickoffOperation.InitializeState(StateMachineLocal, StateField, InitialState));
        operations.Add(KickoffOperation.StartStateMachine(StateMachineLocal, BuilderField, BuilderStartMethod));

        operations.Add(BuilderTaskProperty != null
            ? KickoffOperation.ReturnBuilderTask(StateMachineLocal, BuilderField, BuilderTaskProperty)
            : KickoffOperation.ReturnVoid());

        return operations.ToImmutable();
    }
}

/// <summary>
/// One ordered operation in the planned kickoff stub.
/// </summary>
public sealed class KickoffOperation
{
    private KickoffOperation(
        KickoffOperationKind kind,
        LocalVariableSymbol stateMachineLocal = null,
        FieldSymbol field = null,
        ParameterSymbol parameter = null,
        int? initialState = null,
        MethodInfo method = null,
        PropertyInfo property = null)
    {
        Kind = kind;
        StateMachineLocal = stateMachineLocal;
        Field = field;
        Parameter = parameter;
        InitialState = initialState;
        Method = method;
        Property = property;
    }

    /// <summary>Gets the operation kind.</summary>
    public KickoffOperationKind Kind { get; }

    /// <summary>Gets the state-machine local for operations that target it.</summary>
    public LocalVariableSymbol StateMachineLocal { get; }

    /// <summary>Gets the state-machine field read or written by the operation.</summary>
    public FieldSymbol Field { get; }

    /// <summary>Gets the kickoff parameter copied by the operation.</summary>
    public ParameterSymbol Parameter { get; }

    /// <summary>Gets the initial state value written by the operation.</summary>
    public int? InitialState { get; }

    /// <summary>Gets the builder method called by the operation.</summary>
    public MethodInfo Method { get; }

    /// <summary>Gets the builder property read by the operation.</summary>
    public PropertyInfo Property { get; }

    /// <summary>Creates a state-machine local declaration operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation DeclareStateMachineLocal(LocalVariableSymbol stateMachineLocal)
    {
        return new KickoffOperation(
            KickoffOperationKind.DeclareStateMachineLocal,
            stateMachineLocal: stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)));
    }

    /// <summary>Creates a builder initialization operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <param name="builderField">The builder field.</param>
    /// <param name="createMethod">The builder <c>Create</c> method.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation InitializeBuilder(LocalVariableSymbol stateMachineLocal, FieldSymbol builderField, MethodInfo createMethod)
    {
        return new KickoffOperation(
            KickoffOperationKind.InitializeBuilder,
            stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)),
            builderField ?? throw new ArgumentNullException(nameof(builderField)),
            method: createMethod ?? throw new ArgumentNullException(nameof(createMethod)));
    }

    /// <summary>Creates a receiver copy operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <param name="thisField">The synthesized <c>this</c> field.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation CopyThis(LocalVariableSymbol stateMachineLocal, FieldSymbol thisField)
    {
        return new KickoffOperation(
            KickoffOperationKind.CopyThis,
            stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)),
            thisField ?? throw new ArgumentNullException(nameof(thisField)));
    }

    /// <summary>Creates a parameter copy operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <param name="parameter">The kickoff parameter.</param>
    /// <param name="parameterField">The hoisted parameter field.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation CopyParameter(LocalVariableSymbol stateMachineLocal, ParameterSymbol parameter, FieldSymbol parameterField)
    {
        return new KickoffOperation(
            KickoffOperationKind.CopyParameter,
            stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)),
            parameterField ?? throw new ArgumentNullException(nameof(parameterField)),
            parameter ?? throw new ArgumentNullException(nameof(parameter)));
    }

    /// <summary>Creates a state initialization operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <param name="stateField">The state field.</param>
    /// <param name="initialState">The initial state value.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation InitializeState(LocalVariableSymbol stateMachineLocal, FieldSymbol stateField, int initialState)
    {
        return new KickoffOperation(
            KickoffOperationKind.InitializeState,
            stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)),
            stateField ?? throw new ArgumentNullException(nameof(stateField)),
            initialState: initialState);
    }

    /// <summary>Creates a state-machine start operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <param name="builderField">The builder field.</param>
    /// <param name="startMethod">The builder <c>Start</c> method.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation StartStateMachine(LocalVariableSymbol stateMachineLocal, FieldSymbol builderField, MethodInfo startMethod)
    {
        return new KickoffOperation(
            KickoffOperationKind.StartStateMachine,
            stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)),
            builderField ?? throw new ArgumentNullException(nameof(builderField)),
            method: startMethod ?? throw new ArgumentNullException(nameof(startMethod)));
    }

    /// <summary>Creates a builder task return operation.</summary>
    /// <param name="stateMachineLocal">The state-machine local.</param>
    /// <param name="builderField">The builder field.</param>
    /// <param name="taskProperty">The builder <c>Task</c> property.</param>
    /// <returns>The operation.</returns>
    public static KickoffOperation ReturnBuilderTask(LocalVariableSymbol stateMachineLocal, FieldSymbol builderField, PropertyInfo taskProperty)
    {
        return new KickoffOperation(
            KickoffOperationKind.ReturnBuilderTask,
            stateMachineLocal ?? throw new ArgumentNullException(nameof(stateMachineLocal)),
            builderField ?? throw new ArgumentNullException(nameof(builderField)),
            property: taskProperty ?? throw new ArgumentNullException(nameof(taskProperty)));
    }

    /// <summary>Creates a void return operation.</summary>
    /// <returns>The operation.</returns>
    public static KickoffOperation ReturnVoid()
    {
        return new KickoffOperation(KickoffOperationKind.ReturnVoid);
    }
}

/// <summary>
/// Planned copy from a kickoff parameter into its hoisted state-machine field.
/// </summary>
public sealed class KickoffParameterCopy
{
    /// <summary>Initializes a new instance of the <see cref="KickoffParameterCopy"/> class.</summary>
    /// <param name="parameter">The kickoff parameter.</param>
    /// <param name="field">The state-machine field receiving the parameter value.</param>
    public KickoffParameterCopy(ParameterSymbol parameter, FieldSymbol field)
    {
        Parameter = parameter ?? throw new ArgumentNullException(nameof(parameter));
        Field = field ?? throw new ArgumentNullException(nameof(field));
    }

    /// <summary>Gets the kickoff parameter.</summary>
    public ParameterSymbol Parameter { get; }

    /// <summary>Gets the state-machine field receiving the parameter value.</summary>
    public FieldSymbol Field { get; }
}
