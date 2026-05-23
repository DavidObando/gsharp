// <copyright file="BoundFunctionLiteralExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

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
        FunctionSymbol function,
        FunctionTypeSymbol type,
        BoundBlockStatement body,
        ImmutableArray<VariableSymbol> capturedVariables)
    {
        Function = function;
        FunctionType = type;
        Body = body;
        CapturedVariables = capturedVariables;
    }

    public FunctionSymbol Function { get; }

    public FunctionTypeSymbol FunctionType { get; }

    public BoundBlockStatement Body { get; }

    public ImmutableArray<VariableSymbol> CapturedVariables { get; }

    public override TypeSymbol Type => FunctionType;

    public override BoundNodeKind Kind => BoundNodeKind.FunctionLiteralExpression;
}
