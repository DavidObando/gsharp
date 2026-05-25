// <copyright file="KickoffBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

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

    /// <summary>Gets a value indicating whether the kickoff stub returns <c>builder.Task</c>.</summary>
    public bool ReturnsBuilderTask => BuilderTaskProperty != null;
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
