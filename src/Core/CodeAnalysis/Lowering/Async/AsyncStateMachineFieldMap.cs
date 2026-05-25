// <copyright file="AsyncStateMachineFieldMap.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Maps user variables and synthesized control slots to the fields on a
/// materialized async state-machine aggregate.
/// </summary>
/// <remarks>
/// The state-machine rewriter needs to replace local/parameter reads with
/// field reads against the generated <c>this</c> receiver. This helper is the
/// bridge between the pure <see cref="SynthesizedStateMachineType"/> model and
/// the existing bound-tree nodes, which are keyed by <see cref="StructSymbol"/>.
/// </remarks>
public sealed class AsyncStateMachineFieldMap
{
    private readonly Dictionary<ParameterSymbol, FieldSymbol> parameterFields = new Dictionary<ParameterSymbol, FieldSymbol>();
    private readonly Dictionary<VariableSymbol, FieldSymbol> localFields = new Dictionary<VariableSymbol, FieldSymbol>();

    private AsyncStateMachineFieldMap(SynthesizedStateMachineType stateMachine, StructSymbol structType)
    {
        StateMachine = stateMachine;
        StructType = structType;
    }

    /// <summary>Gets the synthesized state-machine model.</summary>
    public SynthesizedStateMachineType StateMachine { get; }

    /// <summary>Gets the materialized aggregate symbol backing field accesses.</summary>
    public StructSymbol StructType { get; }

    /// <summary>Gets the hoisted state field.</summary>
    public FieldSymbol StateField => StateMachine.StateField;

    /// <summary>Gets the hoisted async method builder field.</summary>
    public FieldSymbol BuilderField => StateMachine.BuilderField;

    /// <summary>Gets the optional hoisted <c>this</c> field.</summary>
    public FieldSymbol ThisField => StateMachine.ThisField;

    /// <summary>
    /// Creates a field map for <paramref name="stateMachine"/> using the same
    /// capture-walker ordering that populated the state-machine fields.
    /// </summary>
    /// <param name="stateMachine">The synthesized state-machine type.</param>
    /// <param name="loweredBody">The lowered async body used to compute hoisted locals.</param>
    /// <returns>A field map whose <see cref="StructType"/> is ready for bound field access nodes.</returns>
    public static AsyncStateMachineFieldMap Create(SynthesizedStateMachineType stateMachine, BoundStatement loweredBody)
    {
        if (stateMachine == null)
        {
            throw new ArgumentNullException(nameof(stateMachine));
        }

        if (loweredBody == null)
        {
            throw new ArgumentNullException(nameof(loweredBody));
        }

        var structType = stateMachine.MaterializeAsStructSymbol();
        var map = new AsyncStateMachineFieldMap(stateMachine, structType);
        var hoist = AsyncCaptureWalker.Analyze(loweredBody, stateMachine.KickoffMethod.Parameters);
        var fields = stateMachine.Fields;
        var fieldIndex = 2;
        if (stateMachine.ThisField != null)
        {
            fieldIndex++;
        }

        foreach (var parameter in hoist.Parameters)
        {
            map.parameterFields.Add(parameter, RequireField(fields, fieldIndex++, parameter.Name));
        }

        foreach (var local in hoist.Locals)
        {
            map.localFields.Add(local, RequireField(fields, fieldIndex++, null));
        }

        return map;
    }

    /// <summary>Gets the hoisted field corresponding to a kickoff parameter.</summary>
    /// <param name="parameter">The kickoff parameter.</param>
    /// <returns>The corresponding state-machine field.</returns>
    public FieldSymbol GetParameterField(ParameterSymbol parameter)
    {
        if (parameter == null)
        {
            throw new ArgumentNullException(nameof(parameter));
        }

        return parameterFields.TryGetValue(parameter, out var field)
            ? field
            : throw new KeyNotFoundException($"Parameter '{parameter.Name}' is not hoisted into state machine '{StateMachine.Name}'.");
    }

    /// <summary>Gets the hoisted field corresponding to a user local.</summary>
    /// <param name="local">The user local.</param>
    /// <returns>The corresponding state-machine field.</returns>
    public FieldSymbol GetLocalField(VariableSymbol local)
    {
        if (local == null)
        {
            throw new ArgumentNullException(nameof(local));
        }

        return localFields.TryGetValue(local, out var field)
            ? field
            : throw new KeyNotFoundException($"Local '{local.Name}' is not hoisted into state machine '{StateMachine.Name}'.");
    }

    /// <summary>Creates a field read against a state-machine receiver expression.</summary>
    /// <param name="receiver">The state-machine receiver expression.</param>
    /// <param name="field">The field to read.</param>
    /// <returns>A bound field-access expression using the materialized aggregate.</returns>
    public BoundFieldAccessExpression Read(BoundExpression receiver, FieldSymbol field)
    {
        if (receiver == null)
        {
            throw new ArgumentNullException(nameof(receiver));
        }

        if (field == null)
        {
            throw new ArgumentNullException(nameof(field));
        }

        return new BoundFieldAccessExpression(receiver, StructType, field);
    }

    /// <summary>Creates a field assignment against a state-machine receiver variable.</summary>
    /// <param name="receiver">The state-machine receiver variable.</param>
    /// <param name="field">The field to assign.</param>
    /// <param name="value">The value being stored.</param>
    /// <returns>A bound field-assignment expression using the materialized aggregate.</returns>
    public BoundFieldAssignmentExpression Write(VariableSymbol receiver, FieldSymbol field, BoundExpression value)
    {
        if (receiver == null)
        {
            throw new ArgumentNullException(nameof(receiver));
        }

        if (field == null)
        {
            throw new ArgumentNullException(nameof(field));
        }

        if (value == null)
        {
            throw new ArgumentNullException(nameof(value));
        }

        return new BoundFieldAssignmentExpression(receiver, StructType, field, value);
    }

    /// <summary>
    /// Attempts to find the hoisted field for a variable (local or parameter).
    /// Returns <c>true</c> if the variable is hoisted.
    /// </summary>
    /// <param name="variable">The variable to look up.</param>
    /// <param name="field">The hoisted field, if found.</param>
    /// <returns><c>true</c> if the variable is hoisted; otherwise <c>false</c>.</returns>
    public bool TryGetHoistedField(VariableSymbol variable, out FieldSymbol field)
    {
        if (variable is ParameterSymbol ps)
        {
            return parameterFields.TryGetValue(ps, out field);
        }

        return localFields.TryGetValue(variable, out field);
    }

    private static FieldSymbol RequireField(System.Collections.Immutable.ImmutableArray<FieldSymbol> fields, int index, string expectedName)
    {
        if (index < 0 || index >= fields.Length)
        {
            throw new InvalidOperationException("Synthesized state-machine field layout does not match the capture walker output.");
        }

        var field = fields[index];
        if (expectedName != null && field.Name != expectedName)
        {
            throw new InvalidOperationException("Synthesized state-machine field layout does not match the capture walker output.");
        }

        return field;
    }
}
