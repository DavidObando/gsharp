// <copyright file="ClosureValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Runtime representation of a function-literal value (Phase 4.7, interpreter-only).
/// Captures the synthetic function symbol, body, signature, and a value-snapshot of captured locals.
/// </summary>
public sealed class ClosureValue
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ClosureValue"/> class.
    /// </summary>
    /// <param name="function">The synthetic function symbol.</param>
    /// <param name="body">The lambda body.</param>
    /// <param name="functionType">The function-type signature.</param>
    /// <param name="capturedLocals">Value-snapshot of captured locals at literal-evaluation time.</param>
    /// <param name="capturedTypeArguments">Generic type-argument bindings visible at literal-evaluation time.</param>
    public ClosureValue(
        FunctionSymbol function,
        BoundBlockStatement body,
        FunctionTypeSymbol functionType,
        Dictionary<VariableSymbol, object> capturedLocals,
        Dictionary<TypeParameterSymbol, TypeSymbol> capturedTypeArguments)
    {
        Function = function;
        Body = body;
        FunctionType = functionType;
        CapturedLocals = capturedLocals;
        CapturedTypeArguments = capturedTypeArguments;
    }

    /// <summary>Gets the synthetic function symbol.</summary>
    public FunctionSymbol Function { get; }

    /// <summary>Gets the lambda body.</summary>
    public BoundBlockStatement Body { get; }

    /// <summary>Gets the function type.</summary>
    public FunctionTypeSymbol FunctionType { get; }

    /// <summary>Gets the captured locals snapshot.</summary>
    public Dictionary<VariableSymbol, object> CapturedLocals { get; }

    /// <summary>Gets the captured generic type-argument bindings.</summary>
    public Dictionary<TypeParameterSymbol, TypeSymbol> CapturedTypeArguments { get; }
}
