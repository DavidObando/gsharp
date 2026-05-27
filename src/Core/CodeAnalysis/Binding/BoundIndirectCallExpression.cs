// <copyright file="BoundIndirectCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A call through a function-typed value (Phase 4.7). The <see cref="Target"/>
/// expression evaluates to a closure / function value at runtime; the
/// evaluator invokes it with the bound <see cref="Arguments"/>.
/// </summary>
public sealed class BoundIndirectCallExpression : BoundExpression
{
    public BoundIndirectCallExpression(SyntaxNode syntax, BoundExpression target, FunctionTypeSymbol functionType, ImmutableArray<BoundExpression> arguments)
        : base(syntax)
    {
        Target = target;
        FunctionType = functionType;
        Arguments = arguments;
    }

    public BoundExpression Target { get; }

    public FunctionTypeSymbol FunctionType { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public override TypeSymbol Type => FunctionType.ReturnType;

    public override BoundNodeKind Kind => BoundNodeKind.IndirectCallExpression;
}
