// <copyright file="BoundFunctionLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A bound function literal (Phase 4.7). Holds a synthesized
/// <see cref="FunctionSymbol"/> together with the bound body. The set of
/// captured outer variables is recorded so the evaluator can snapshot them
/// when the literal is evaluated to a runtime closure value.
/// </summary>
public sealed class BoundFunctionLiteralExpression : BoundExpression
{
    public BoundFunctionLiteralExpression(
        SyntaxNode? syntax,
        FunctionSymbol function,
        FunctionTypeSymbol type,
        BoundBlockStatement body,
        ImmutableArray<VariableSymbol> capturedVariables)
        : base(syntax)
    {
        Function = function;
        FunctionType = type;
        Body = body;
        CapturedVariables = capturedVariables;
    }

    public FunctionSymbol Function { get; }

    public FunctionTypeSymbol FunctionType { get; }

    public BoundBlockStatement Body { get; }

    /// <summary>
    /// Gets the set of outer variables this literal reads or writes. The
    /// setter is internal: issue #4221's transitive-capture reconciliation
    /// (<see cref="LambdaBinder.ReconcileGenericLocalFunctionGroupCaptures"/>)
    /// widens this set after initial binding when a generic local function
    /// calls a sibling that itself captures outer state, so the caller's
    /// synthesized environment ends up with a field for every variable any
    /// callee it directly invokes will need at the call site.
    /// </summary>
    public ImmutableArray<VariableSymbol> CapturedVariables { get; internal set; }

    public override TypeSymbol Type => FunctionType;

    public override BoundNodeKind Kind => BoundNodeKind.FunctionLiteralExpression;

    /// <summary>
    /// Gets or sets the evaluator's lazily lowered body. Concurrent first use
    /// may compute equivalent bodies; <c>Lower</c> allocates a fresh
    /// <c>Lowerer</c> per call and holds no static state, so either cached value
    /// is safe.
    /// </summary>
    internal BoundBlockStatement? LoweredBody { get; set; }
}
