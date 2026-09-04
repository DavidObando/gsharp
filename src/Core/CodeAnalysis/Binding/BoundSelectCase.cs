// <copyright file="BoundSelectCase.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Diagnostics.CodeAnalysis;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A single bound arm of a <c>select</c> statement (Phase 5.6 / ADR-0022).
/// </summary>
public sealed record BoundSelectCase
{
    /// <summary>Initializes a new instance of the <see cref="BoundSelectCase"/> class.</summary>
    /// <param name="caseKind">Which arm shape this is.</param>
    /// <param name="channel">Channel expression for send/receive arms; null for default.</param>
    /// <param name="value">Value expression for send arms; null otherwise.</param>
    /// <param name="variable">Declared variable for <c>case v := &lt;-ch</c>; null otherwise.</param>
    /// <param name="body">Bound case body.</param>
    public BoundSelectCase(
        SelectCaseKind caseKind,
        BoundExpression? channel,
        BoundExpression? value,
        VariableSymbol? variable,
        BoundStatement body)
        : this(caseKind, channel, value, variable, guard: null, body)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundSelectCase"/> class.</summary>
    /// <param name="caseKind">Which arm shape this is.</param>
    /// <param name="channel">Channel, selectable or task operand; null for default and cancelled arms.</param>
    /// <param name="value">Value expression for send arms; null otherwise.</param>
    /// <param name="variable">Declared variable for a binding arm; null otherwise.</param>
    /// <param name="guard">The arm's <c>when</c> guard (ADR-0174 D8); null when it has none.</param>
    /// <param name="body">Bound case body.</param>
    public BoundSelectCase(
        SelectCaseKind caseKind,
        BoundExpression? channel,
        BoundExpression? value,
        VariableSymbol? variable,
        BoundExpression? guard,
        BoundStatement body)
    {
        CaseKind = caseKind;
        Channel = channel;
        Value = value;
        Variable = variable;
        Guard = guard;
        Body = body;
    }

    /// <summary>Gets the arm shape.</summary>
    public SelectCaseKind CaseKind { get; }

    /// <summary>Gets the channel expression for send/receive arms; null for default.</summary>
    public BoundExpression? Channel { get; }

    /// <summary>Gets the value expression for send arms; null otherwise.</summary>
    public BoundExpression? Value { get; }

    /// <summary>Gets the declared variable for receive-bind arms; null otherwise.</summary>
    public VariableSymbol? Variable { get; }

    /// <summary>
    /// Gets the arm's <c>when</c> guard (ADR-0174 D8), or <see langword="null"/>.
    /// Evaluated once when the select is entered; a false guard keeps the arm
    /// out of the waiter entirely.
    /// </summary>
    public BoundExpression? Guard { get; }

    /// <summary>Gets the bound case body.</summary>
    public BoundStatement Body { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    // Every non-default arm references a channel -- the binder binds one before
    // it can classify the arm at all, including on the error-recovery path.
    // Value has no such guarantee: a send arm whose channel failed to bind is
    // recovered with a null value.
    [MemberNotNullWhen(false, nameof(Channel))]
    public bool IsDefault => CaseKind == SelectCaseKind.Default;
}
