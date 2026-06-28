// <copyright file="BoundSelectCase.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

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
        BoundExpression channel,
        BoundExpression value,
        VariableSymbol variable,
        BoundStatement body)
    {
        CaseKind = caseKind;
        Channel = channel;
        Value = value;
        Variable = variable;
        Body = body;
    }

    /// <summary>Gets the arm shape.</summary>
    public SelectCaseKind CaseKind { get; }

    /// <summary>Gets the channel expression for send/receive arms; null for default.</summary>
    public BoundExpression Channel { get; }

    /// <summary>Gets the value expression for send arms; null otherwise.</summary>
    public BoundExpression Value { get; }

    /// <summary>Gets the declared variable for receive-bind arms; null otherwise.</summary>
    public VariableSymbol Variable { get; }

    /// <summary>Gets the bound case body.</summary>
    public BoundStatement Body { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    public bool IsDefault => CaseKind == SelectCaseKind.Default;
}
